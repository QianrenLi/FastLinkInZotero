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
   * Insert `linkHtml` by replacing the literal `[[${triggerText}` range at the
   * saved caret, via the editor's ProseMirror insertHTML. Delegates to the
   * shared trigger-range inserter.
   */
  async insertLinkViaEditor(
    triggerText: string,
    linkHtml: string,
  ): Promise<boolean> {
    return this.insertHtmlAtTrigger(`[[${triggerText}`, linkHtml);
  }

  /**
   * Insert `html` by selecting the literal `fullTrigger` range ending at the
   * saved caret and replacing it via the editor's ProseMirror insertHTML — no
   * DB write, so no editor reload. Used by both `[[` (fullTrigger="[[query") and
   * slash commands (fullTrigger="/word"). Returns false when the editor instance
   * can't be located or the range can't be selected / the insert silently no-ops.
   * Preferred over a DB write because an external write can be clobbered when a
   * second editor's autosave still holds the literal trigger text.
   */
  async insertHtmlAtTrigger(
    fullTrigger: string,
    html: string,
  ): Promise<boolean> {
    const editorWin = this._savedWindow;
    if (!editorWin || !this._savedRange) return false;
    try {
      const instances = (Zotero as any).Notes?._editorInstances ?? [];
      const inst = instances.find((e: any) => e?._iframeWindow === editorWin);
      if (!inst?._postMessage) {
        Zotero.debug(
          "[FastLink] insertHtmlAtTrigger: no matching EditorInstance",
        );
        return false;
      }
      if (!this.selectTriggerRange(editorWin, fullTrigger)) {
        Zotero.debug(
          `[FastLink] insertHtmlAtTrigger: could not select "${fullTrigger}"`,
        );
        return false;
      }
      // Correctness check: ProseMirror's insertHTML can silently drop content
      // (e.g. short <a> tags, or HTML that doesn't match the schema). Detect a
      // no-op by comparing contenteditable text length before/after; the insert
      // must replace `fullTrigger` and add at least one char.
      // Note: this detects an empty-result insert, not partial schema stripping.
      const ceBefore =
        editorWin.document.querySelector('[contenteditable="true"]')
          ?.textContent ?? "";
      inst._postMessage({ action: "insertHTML", html });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const ceAfter =
        editorWin.document.querySelector('[contenteditable="true"]')
          ?.textContent ?? "";
      const ok = ceAfter.length > ceBefore.length - fullTrigger.length;
      Zotero.debug(`[FastLink] insertHtmlAtTrigger "${fullTrigger}" ok=${ok}`);
      if (!ok) {
        this.clearSavedSelection();
        return false;
      }
      this.clearSavedSelection();
      return true;
    } catch (e) {
      Zotero.debug(`[FastLink] insertHtmlAtTrigger error: ${e}`);
      return false;
    }
  }

  /**
   * Select the literal `[[query` text that ends at the saved caret, so the
   * editor's insertHTML(at-selection) replaces it. Tries the cached saved
   * range first; falls back to searching the editor DOM when the range is
   * stale (e.g. after a createNote/restoreEditorToNote cycle detached its
   * container nodes from the document).
   */
  private selectTriggerRange(editorWin: Window, fullTrigger: string): boolean {
    try {
      const sel = editorWin.getSelection();
      if (!sel) return false;

      // Try the cached saved range first
      if (this._savedRange) {
        try {
          const ec = this._savedRange.endContainer;
          if (
            ec.nodeType === 3 /* Node.TEXT_NODE */ &&
            ec.ownerDocument === editorWin.document
          ) {
            const textBefore = (ec.nodeValue ?? "").slice(
              0,
              this._savedRange.endOffset,
            );
            if (textBefore.endsWith(fullTrigger)) {
              const startOffset =
                this._savedRange.endOffset - fullTrigger.length;
              const range = editorWin.document.createRange();
              range.setStart(ec, startOffset);
              range.setEnd(ec, this._savedRange.endOffset);
              sel.removeAllRanges();
              sel.addRange(range);
              return true;
            }
          }
        } catch {
          // Stale — fall through to DOM search
        }
      }

      // Fallback: walk text nodes backward. Used when the editor was
      // switched away and back (CREATE flow), detaching original range nodes.
      const ce = editorWin.document.querySelector('[contenteditable="true"]');
      if (!ce) return false;
      const doc = editorWin.document;
      const walker = doc.createTreeWalker(ce, 4 /* NodeFilter.SHOW_TEXT */);
      let lastNode: Text | null = null;
      while (walker.nextNode()) lastNode = walker.currentNode as Text;
      if (!lastNode) return false;

      let node: Node | null = lastNode;
      while (node) {
        if (node.nodeType === 3 /* Node.TEXT_NODE */) {
          const idx = (node.nodeValue ?? "").lastIndexOf(fullTrigger);
          if (idx >= 0) {
            const range = doc.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + fullTrigger.length);
            sel.removeAllRanges();
            sel.addRange(range);
            return true;
          }
        }
        walker.currentNode = node;
        node = walker.previousNode();
      }
      return false;
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
   * Lightweight DB-write fallback for slash commands: find the last occurrence
   * of `triggerToken` (e.g. "/todo") in the LIVE editor HTML — but only in text
   * content, never inside a tag/attribute — replace it with `html`, clean
   * ProseMirror markup (including image wrappers, to avoid the image-shrink
   * bug), and save. Used only when insertHtmlAtTrigger fails. Simpler than the
   * link path: no createNote/autosave race, but it still round-trips live HTML
   * so image cleanup is required.
   *
   * `html` is treated as RAW HTML — callers must HTML-escape any caller-supplied
   * text (the slash handler escapes `kind:"text"` outputs before calling).
   */
  async insertReplacementViaDb(
    triggerToken: string,
    html: string,
  ): Promise<boolean> {
    try {
      const editorWindow = this._savedWindow || getEditorWindow();
      const contentEl = getEditorContentElement(editorWindow);
      if (!contentEl) return false;
      const note = getCurrentNote(editorWindow);
      if (!note) return false;

      const liveHtml = String(contentEl.innerHTML);
      const cleanHtml = note.getNote();
      const idx = this.findLastTokenInText(liveHtml, triggerToken);
      if (idx < 0) return false;
      const newHtml =
        liveHtml.slice(0, idx) +
        html +
        liveHtml.slice(idx + triggerToken.length);

      let cleaned = this.cleanProseMirrorHtml(newHtml);
      // Swap ProseMirror image wrappers (data-URI <div class="regular-image">)
      // for canonical <img data-attachment-key> from the DB content, mirroring
      // insertLink, so images don't shrink on reload.
      if (cleanHtml) {
        cleaned = this.cleanProseMirrorImages(cleaned, cleanHtml);
      }
      note.setNote(cleaned);
      await note.saveTx();
      this.clearSavedSelection();
      return true;
    } catch (e) {
      Zotero.debug(`[FastLink] insertReplacementViaDb error: ${e}`);
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

        // Try clean HTML first (from getNote() / DB, which is the canonical
        // note format without ProseMirror rendering artifacts like data URIs
        // and image wrapper divs). Saving clean HTML back avoids an editor
        // reload with "fat" live HTML that makes images render differently.
        if (!newHtml && cleanHtml) {
          newHtml = this.replaceInHtml(cleanHtml, fullTrigger, linkHtml);
          usedSource = "clean";
        }

        // Log whether cleanHtml had the trigger — this tells us if autosave
        // flushed [[query to DB before the user selected a link target.
        if (usedSource !== "clean" && cleanHtml) {
          Zotero.debug(
            `[FastLink] insertLink #${seq} cleanHtml MISS (trigger="${fullTrigger}" not in DB content — autosave hasn't flushed)`,
          );
        }

        // Fall back to live/pre-captured HTML if the trigger was not in the
        // clean HTML (e.g. the editor autosave hadn't flushed it to DB yet).
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
        let cleanedHtml =
          usedSource !== "clean"
            ? this.cleanProseMirrorHtml(htmlWithoutMarker)
            : htmlWithoutMarker;

        // When we fell back to live HTML, image elements carry ProseMirror
        // rendering artifacts: wrapper divs (regular-image, resized-wrapper)
        // and data-URI src attributes. Replace them with canonical <img>
        // tags from clean HTML to avoid the image-shrink-on-reload bug.
        if (usedSource !== "clean" && cleanHtml) {
          cleanedHtml = this.cleanProseMirrorImages(cleanedHtml, cleanHtml);
        }

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
   * Find the last occurrence of `token` in `html` that lies in TEXT content
   * (not inside a tag or attribute value). Used by the DB-write fallback so a
   * short token like "/todo" can't accidentally match inside a URL/attribute
   * such as <a href="https://x/todo"> and corrupt the markup. Returns the
   * character index, or -1 if no in-text match exists.
   */
  private findLastTokenInText(html: string, token: string): number {
    let from = html.length;
    for (;;) {
      const idx = html.lastIndexOf(token, from - 1);
      if (idx < 0) return -1;
      const lastOpen = html.lastIndexOf("<", idx);
      const lastClose = html.lastIndexOf(">", idx);
      // In text content iff the nearest preceding tag delimiter is a close '>'
      // (or there is no tag before the match at all).
      if (lastClose >= lastOpen) return idx;
      from = idx; // token was inside a tag/attribute; keep scanning backward
    }
  }

  /**
   * Strip ProseMirror-specific markup from live HTML that would cause
   * Zotero's parser to insert extra blank lines. Only targets known
   * ProseMirror-only artefacts (trailing breaks, data-pm-slice).
   * Does NOT strip `contenteditable` or `class` attributes — they are
   * used on content nodes such as `<img>` where stripping them causes
   * image rendering issues (see the image-shrink bug).
   */
  private cleanProseMirrorHtml(html: string): string {
    return html
      .replace(/<br\s+class="ProseMirror-trailingBreak"\s*\/?>/gi, "")
      .replace(/\s+data-pm-slice="[^"]*"/gi, "")
      .replace(/(<\/p>\s*){2,}/g, "</p>");
  }

  /**
   * Replace ProseMirror-rendered image wrappers in live HTML with canonical
   * `<img>` tags from clean HTML (DB format). ProseMirror wraps images in
   * `<div class="regular-image" contenteditable="false">...</div>` with data
   * URI `src` attributes, but the canonical DB format is a bare `<img>` tag
   * with `data-attachment-key`, `width`, `height` attributes and NO `src`.
   *
   * We extract canonical `<img>` tags from clean HTML and replace each
   * corresponding live-HTML wrapper (including its inner divs and img) with
   * the canonical tag. This avoids the image-shrink bug where saving data-URI
   * images with wrapper divs to DB causes the editor to re-render images at
   * the wrong size.
   */
  private cleanProseMirrorImages(html: string, cleanHtml: string): string {
    // Extract canonical <img> tags from clean HTML
    const CANON_IMG = /<img\s[^>]*data-attachment-key="[^"]*"[^>]*\/?>/gi;
    const canonImgs = cleanHtml.match(CANON_IMG);
    if (!canonImgs || canonImgs.length === 0) return html;

    let result = html;
    // For each canonical image, find and replace ONE corresponding
    // ProseMirror image wrapper block in the live HTML.
    for (const canonTag of canonImgs) {
      // Match one ProseMirror wrapper: starts with <div class="regular-image"
      // (or similar contenteditable wrapper), contains an <img>, and
      // ends with </div> having matching indentation.
      // We use a simpler approach: find an <img> with data URI, then
      // walk backward to find its outermost wrapper div.
      const dataImgMatch = /<img\s[^>]*src="data:image\/[^"]*"[^>]*\/?>/i.exec(
        result,
      );
      if (!dataImgMatch) break; // no more data-URI images

      const imgPos = dataImgMatch.index;
      const imgLen = dataImgMatch[0].length;

      // Search backward from the img for <div class="regular-image" or
      // similar contenteditable="false" wrapper.
      const before = result.substring(0, imgPos);
      const wrapperStartMatch = before.match(
        /<div\s[^>]*class="[^"]*regular-image[^"]*"[^>]*>[\s\S]*$/,
      );
      if (!wrapperStartMatch) {
        // Fallback: search for any <div with contenteditable="false"
        const fallMatch = before.match(
          /<div\s[^>]*contenteditable="false"[^>]*>[\s\S]*$/,
        );
        if (!fallMatch) break;
        const startPos = fallMatch.index!;
        // Find the matching </div> after the img
        let depth = 1;
        let searchPos = imgPos + imgLen;
        while (depth > 0 && searchPos < result.length) {
          const nextOpen = result.indexOf("<div", searchPos);
          const nextClose = result.indexOf("</div>", searchPos);
          if (nextClose < 0) break;
          if (nextOpen >= 0 && nextOpen < nextClose) {
            depth++;
            searchPos = nextOpen + 4;
          } else {
            depth--;
            if (depth === 0) {
              // Replace the entire wrapper block with the canonical img tag
              result =
                result.substring(0, startPos) +
                canonTag +
                result.substring(nextClose + 6);
              break;
            }
            searchPos = nextClose + 6;
          }
        }
        continue;
      }

      const startPos = wrapperStartMatch.index!;
      // Find the matching </div> after the img
      let depth = 1;
      let searchPos = imgPos + imgLen;
      while (depth > 0 && searchPos < result.length) {
        const nextOpen = result.indexOf("<div", searchPos);
        const nextClose = result.indexOf("</div>", searchPos);
        if (nextClose < 0) break;
        if (nextOpen >= 0 && nextOpen < nextClose) {
          depth++;
          searchPos = nextOpen + 4;
        } else {
          depth--;
          if (depth === 0) {
            result =
              result.substring(0, startPos) +
              canonTag +
              result.substring(nextClose + 6);
            break;
          }
          searchPos = nextClose + 6;
        }
      }
    }

    return result;
  }
}
