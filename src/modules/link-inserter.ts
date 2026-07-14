// src/modules/link-inserter.ts
import {
  getCurrentNote,
  getEditorContentElement,
  getEditorWindow,
} from "../utils/editor-detector";
import { escapeHtml } from "../utils/html";
import { getPref } from "../utils/prefs";

export interface LinkInsertOptions {
  noteId: number;
  noteTitle: string;
  triggerText?: string; // raw query text between [[ and cursor
  liveHtml?: string;
  sourceNoteId?: number; // ID of the note being edited (avoids re-querying getCurrentNote)
  // Verify the link persisted after saveTx and retry if a concurrent editor
  // autosave overwrote it. Only the create flow is exposed to that race, so
  // the reuse path sets this false to skip the extra read. Defaults true.
  verifyPersisted?: boolean;
}

export class LinkInserter {
  private _savedWindow: Window | null = null;
  private _savedRange: Range | null = null;
  // Monotonic counter so debug logs can correlate concurrent/rapid insertions.
  private _insertSeq = 0;

  saveSelection(editorWindow: Window | null = getEditorWindow()): void {
    if (!editorWindow) return;
    try {
      this._savedWindow = editorWindow;
      const selection = editorWindow.getSelection();
      this._savedRange =
        selection && selection.rangeCount > 0
          ? selection.getRangeAt(0).cloneRange()
          : null;
    } catch {
      // selection access can fail
    }
  }

  getSavedWindow(): Window | null {
    return this._savedWindow;
  }

  /**
   * Insert a link by driving the note editor's own ProseMirror instance via its
   * `insertHTML` message — NOT via an external setNote/saveTx.
   *
   * Why: when a note is open in two editors at once (e.g. the main window's
   * item pane AND a separate note window), an external DB write gets clobbered
   * by the editor you're typing in, which still holds the literal `[[query` and
   * autosaves it back over the link (the two-editor fight). Inserting through
   * the editor updates its own state, so its autosave carries the link and the
   * fight can't happen.
   *
   * Returns false when the editor instance can't be located or the `[[query`
   * range can't be selected; callers fall back to the external-write path.
   */
  async insertLinkViaEditor(
    triggerText: string,
    linkHtml: string,
  ): Promise<boolean> {
    const editorWin = this._savedWindow;
    if (!editorWin || !this._savedRange) return false;
    try {
      const instances = (Zotero as any).Notes?._editorInstances ?? [];
      const inst = instances.find((e: any) => e?._iframeWindow === editorWin);
      if (!inst?._postMessage) {
        Zotero.debug(
          "[FastLink] insertLinkViaEditor: no matching EditorInstance",
        );
        return false;
      }
      const fullTrigger = `[[${triggerText}`;
      if (!this.selectTriggerRange(editorWin, fullTrigger)) {
        Zotero.debug(
          `[FastLink] insertLinkViaEditor: could not select "${fullTrigger}"`,
        );
        return false;
      }
      inst._postMessage({ action: "insertHTML", pos: null, html: linkHtml });
      Zotero.debug(
        `[FastLink] insertLinkViaEditor: posted insertHTML for "${triggerText}"`,
      );
      this.clearSavedSelection();
      return true;
    } catch (e) {
      Zotero.debug(`[FastLink] insertLinkViaEditor error: ${e}`);
      return false;
    }
  }

  /**
   * Select the literal `[[query` text that ends at the saved caret, so the
   * editor's insertHTML(at-selection) replaces it. Only handles the common case
   * where the trigger sits in the same text node as the caret.
   */
  private selectTriggerRange(editorWin: Window, fullTrigger: string): boolean {
    try {
      const sel = editorWin.getSelection();
      if (!sel || !this._savedRange) return false;
      const endContainer = this._savedRange.endContainer;
      const endOffset = this._savedRange.endOffset;
      if (endContainer.nodeType !== Node.TEXT_NODE) return false;
      const textBefore = (endContainer.nodeValue ?? "").slice(0, endOffset);
      if (!textBefore.endsWith(fullTrigger)) return false;
      const startOffset = endOffset - fullTrigger.length;
      const range = editorWin.document.createRange();
      range.setStart(endContainer, startOffset);
      range.setEnd(endContainer, endOffset);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch {
      return false;
    }
  }

  buildLinkUri(item: Zotero.Item): string {
    const mode = getPref("linkMode");
    if (mode === "better-notes") {
      return item.libraryID === Zotero.Libraries.userLibraryID
        ? `zotero://note/u/${item.key}/`
        : `zotero://note/${item.libraryID}/${item.key}/`;
    }
    return `zotero://select/library/items/${item.key}`;
  }

  async copyLinkToClipboard(
    noteId: number,
    noteTitle: string,
  ): Promise<boolean> {
    try {
      const item = await Zotero.Items.getAsync(noteId);
      if (!item) return false;

      const linkUri = this.buildLinkUri(item);
      Zotero.Utilities.Internal.copyTextToClipboard(
        `[${noteTitle}](${linkUri})`,
      );
      return true;
    } catch (e) {
      Zotero.debug(`[FastLink] copyLinkToClipboard error: ${e}`);
      return false;
    }
  }

  /**
   * Insert a note link by modifying the note HTML directly via Zotero API.
   * Finds [[query in the note HTML and replaces it with a zotero:// link.
   */
  async insertLink(options: LinkInsertOptions): Promise<boolean> {
    const {
      noteId,
      noteTitle,
      triggerText,
      liveHtml: preCapturedHtml,
      sourceNoteId,
    } = options;

    const seq = ++this._insertSeq;
    Zotero.debug(
      `[FastLink] insertLink #${seq} noteId=${noteId} sourceNoteId=${
        sourceNoteId ?? "?"
      } trigger="${triggerText ?? ""}"`,
    );

    try {
      const item = await Zotero.Items.getAsync(noteId);
      if (!item) return false;

      const linkUri = this.buildLinkUri(item);
      const currentNote = sourceNoteId
        ? await Zotero.Items.getAsync(sourceNoteId)
        : getCurrentNote();
      if (!currentNote) return false;

      const editorWindow = this._savedWindow || getEditorWindow();
      const contentEl = getEditorContentElement(editorWindow);
      const liveHtml =
        preCapturedHtml ||
        (contentEl
          ? String(contentEl.innerHTML)
          : editorWindow
            ? String(editorWindow.document.body?.innerHTML || "")
            : "");
      const cleanHtml = currentNote.getNote();
      const markerToken = `fastlink-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const markerHtml = `<!--${markerToken}-->`;
      const markedLiveHtml = this.captureLiveHtmlWithMarker(
        markerToken,
        liveHtml,
      );

      const linkHtml = `<a href="${linkUri}">${escapeHtml(noteTitle)}</a>`;

      let newHtml: string | null = null;
      let usedSource: "clean" | "live" | "fallback" = "clean";

      if (triggerText !== undefined) {
        const fullTrigger = `[[${triggerText}`;

        // Try pre-captured HTML first — it was captured before any async work
        // (e.g. createNote) that may have changed the editor to a different note.
        if (!newHtml && preCapturedHtml) {
          newHtml = this.replaceInHtml(preCapturedHtml, fullTrigger, linkHtml);
          usedSource = "live";
        }

        if (!newHtml && markedLiveHtml?.includes(markerHtml)) {
          newHtml = this.replaceBeforeMarker(
            markedLiveHtml,
            markerHtml,
            fullTrigger,
            linkHtml,
          );
          usedSource = "live";
        }

        if (!newHtml) {
          newHtml = this.replaceInHtml(cleanHtml, fullTrigger, linkHtml);
          usedSource = "clean";
        }

        if (!newHtml && markedLiveHtml) {
          newHtml = this.replaceInHtml(
            this.stripMarkerComments(markedLiveHtml, markerToken),
            fullTrigger,
            linkHtml,
          );
          usedSource = "live";
        }

        if (!newHtml && markedLiveHtml?.includes(markerHtml)) {
          newHtml = this.replaceLastBracketBeforeMarker(
            markedLiveHtml,
            markerHtml,
            triggerText,
            linkHtml,
          );
          usedSource = "fallback";
        }

        if (!newHtml && preCapturedHtml) {
          newHtml = this.replaceLastBracketInHtml(
            preCapturedHtml,
            triggerText,
            linkHtml,
          );
          usedSource = "fallback";
        }

        if (!newHtml) {
          newHtml = this.replaceLastBracketInHtml(
            cleanHtml,
            triggerText,
            linkHtml,
          );
          usedSource = "fallback";
        }
      } else if (markedLiveHtml?.includes(markerHtml)) {
        newHtml = markedLiveHtml.replace(markerHtml, linkHtml);
        usedSource = "live";
      }

      Zotero.debug(`[FastLink] insertLink #${seq} usedSource=${usedSource}`);
      if (newHtml) {
        const htmlWithoutMarker = this.stripMarkerComments(
          newHtml,
          markerToken,
        );
        // Only clean ProseMirror markup if we used live HTML as the source
        const cleanedHtml =
          usedSource !== "clean"
            ? this.cleanProseMirrorHtml(htmlWithoutMarker)
            : htmlWithoutMarker;

        currentNote.setNote(cleanedHtml);
        await currentNote.saveTx();

        // Verify the save persisted only when a concurrent editor autosave
        // could have raced us (the create flow). The reuse path has no such
        // race, so it opts out via verifyPersisted: false and skips this read.
        if (options.verifyPersisted !== false) {
          const fresh = await Zotero.Items.getAsync(currentNote.id);
          if (fresh && !fresh.getNote().includes(linkUri)) {
            Zotero.debug(
              `[FastLink] insertLink #${seq} RETRY: link not persisted (autosave race?)`,
            );
            const freshHtml = fresh.getNote();
            const retryTrigger = triggerText ? `[[${triggerText}` : "";
            const retriedHtml = retryTrigger
              ? this.replaceInHtml(freshHtml, retryTrigger, linkHtml)
              : null;
            if (retriedHtml) {
              fresh.setNote(retriedHtml);
              await fresh.saveTx();
            }
          }
        }

        this.clearSavedSelection();
        return true;
      }

      Zotero.debug("[FastLink] insertLink: no replacement made");
      return false;
    } catch (e) {
      Zotero.debug(`[FastLink] Error inserting link: ${e}`);
      return false;
    }
  }

  private clearSavedSelection(): void {
    this._savedRange = null;
    this._savedWindow = null;
  }

  private captureLiveHtmlWithMarker(
    markerToken: string,
    fallbackHtml: string,
  ): string | null {
    const editorWindow = this._savedWindow || getEditorWindow();
    // Read the contenteditable root (not <body>, which includes the toolbar in
    // Zotero 9) so the marker is captured against clean note content.
    const contentEl =
      getEditorContentElement(editorWindow) || editorWindow?.document?.body;
    const doc = editorWindow?.document;
    if (!contentEl || !doc || !this._savedRange) {
      return fallbackHtml || null;
    }

    const marker = doc.createComment(markerToken);
    try {
      const range = this._savedRange.cloneRange();
      range.collapse(true);
      range.insertNode(marker);
      return String(contentEl.innerHTML);
    } catch {
      return fallbackHtml || null;
    } finally {
      marker.parentNode?.removeChild(marker);
    }
  }

  private replaceInHtml(
    html: string,
    fullTrigger: string,
    linkHtml: string,
  ): string | null {
    if (!html) return null;

    const direct = html.replace(fullTrigger, linkHtml);
    if (direct !== html) return direct;

    // Cross-tag replace: find [[ in HTML, strip tags from text after it, check match
    const bracketIdx = html.lastIndexOf("[[");
    if (bracketIdx < 0) return null;

    const afterBracket = html.substring(bracketIdx);
    const textOnly = afterBracket.replace(/<[^>]*>/g, "");

    if (textOnly.startsWith(fullTrigger)) {
      let charCount = 0;
      let endIdx = bracketIdx;
      for (
        let i = bracketIdx;
        i < html.length && charCount < fullTrigger.length;
        i++
      ) {
        if (html[i] === "<") {
          const closeIdx = html.indexOf(">", i);
          if (closeIdx >= 0) {
            i = closeIdx;
            continue;
          }
        }
        charCount++;
        endIdx = i + 1;
      }
      return html.substring(0, bracketIdx) + linkHtml + html.substring(endIdx);
    }

    return null;
  }

  private replaceBeforeMarker(
    html: string,
    markerHtml: string,
    fullTrigger: string,
    linkHtml: string,
  ): string | null {
    const markerIdx = html.indexOf(markerHtml);
    if (markerIdx < 0) return null;

    const beforeMarker = html.substring(0, markerIdx);
    const afterMarker = html.substring(markerIdx + markerHtml.length);
    const replacedBefore = this.replaceInHtml(
      beforeMarker,
      fullTrigger,
      linkHtml,
    );
    return replacedBefore ? replacedBefore + afterMarker : null;
  }

  private replaceLastBracketBeforeMarker(
    html: string,
    markerHtml: string,
    triggerText: string,
    linkHtml: string,
  ): string | null {
    const markerIdx = html.indexOf(markerHtml);
    if (markerIdx < 0) return null;

    const beforeMarker = html.substring(0, markerIdx);
    const afterMarker = html.substring(markerIdx + markerHtml.length);
    const replacedBefore = this.replaceLastBracketInHtml(
      beforeMarker,
      triggerText,
      linkHtml,
    );
    return replacedBefore ? replacedBefore + afterMarker : null;
  }

  private replaceLastBracketInHtml(
    html: string,
    triggerText: string,
    linkHtml: string,
  ): string | null {
    const bracketIdx = html.lastIndexOf("[[");
    if (bracketIdx < 0) return null;

    let endIdx = bracketIdx + 2;
    let skipped = 0;
    for (let i = endIdx; i < html.length && skipped < triggerText.length; i++) {
      if (html[i] === "<") {
        const closeIdx = html.indexOf(">", i);
        if (closeIdx >= 0) {
          i = closeIdx;
          continue;
        }
      }
      skipped++;
      endIdx = i + 1;
    }
    return html.substring(0, bracketIdx) + linkHtml + html.substring(endIdx);
  }

  private stripMarkerComments(html: string, markerToken: string): string {
    return html.replaceAll(`<!--${markerToken}-->`, "");
  }

  /**
   * Strip ProseMirror-specific markup from HTML that would cause
   * Zotero's parser to insert extra blank lines.
   */
  private cleanProseMirrorHtml(html: string): string {
    return html
      .replace(/<br\s+class="ProseMirror-trailingBreak"\s*\/?>/gi, "")
      .replace(/\s+contenteditable="[^"]*"/gi, "")
      .replace(/\s+class="ProseMirror[^"]*"/gi, "")
      .replace(/\s+data-pm-slice="[^"]*"/gi, "")
      .replace(/(<\/p>\s*){2,}/g, "</p>");
  }
}
