// src/modules/link-inserter.ts
import { getCurrentNote, getEditorWindow } from "../utils/editor-detector";
import { escapeHtml } from "../utils/html";
import { getPref } from "../utils/prefs";

export interface LinkInsertOptions {
  noteId: number;
  noteTitle: string;
  triggerText?: string; // raw query text between [[ and cursor
  liveHtml?: string;
  sourceNoteId?: number; // ID of the note being edited (avoids re-querying getCurrentNote)
}

export class LinkInserter {
  private _savedWindow: Window | null = null;
  private _savedRange: Range | null = null;

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

  private buildLinkUri(item: Zotero.Item): string {
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

    try {
      const item = await Zotero.Items.getAsync(noteId);
      if (!item) return false;

      const linkUri = this.buildLinkUri(item);
      const currentNote = sourceNoteId
        ? await Zotero.Items.getAsync(sourceNoteId)
        : getCurrentNote();
      if (!currentNote) return false;

      const editorWindow = this._savedWindow || getEditorWindow();
      const liveHtml =
        preCapturedHtml ||
        (editorWindow
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

        // Verify the save persisted — the editor auto-save triggered by
        // createNote can race with our saveTx and overwrite the link.
        // If the link is missing, re-apply on the fresh DB state.
        const fresh = await Zotero.Items.getAsync(currentNote.id);
        if (fresh && !fresh.getNote().includes(linkUri)) {
          Zotero.debug("[FastLink] Retrying link insertion on fresh state");
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
    if (!editorWindow?.document?.body || !this._savedRange) {
      return fallbackHtml || null;
    }

    const marker = editorWindow.document.createComment(markerToken);
    try {
      const range = this._savedRange.cloneRange();
      range.collapse(true);
      range.insertNode(marker);
      return String(editorWindow.document.body.innerHTML);
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
