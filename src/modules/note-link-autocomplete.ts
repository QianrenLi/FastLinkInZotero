// src/modules/note-link-autocomplete.ts
import { LinkInserter } from "./link-inserter";
import { NoteSearchService, SearchResult } from "./note-search-service";
import { PopupController, PopupItem } from "./popup-controller";
import {
  getCurrentNote,
  getEditorWindow,
  getIframeByWindow,
  setCachedEditorWindow,
} from "../utils/editor-detector";
import { escapeHtml } from "../utils/html";

export class NoteLinkAutocomplete {
  private searchService: NoteSearchService;
  private popupController: PopupController | null = null;
  private linkInserter: LinkInserter;
  private isActive = false;
  private triggerBuffer = "";
  private lastKeyTime = 0;
  private _triggerTarget: HTMLElement | null = null;
  private _lastEditorWindow: Window | null = null;
  private _savedCursorPos: { x: number; y: number } | null = null;

  // Event listener cleanup references
  private _notifierID: string | null = null;
  private _editorDocument: Document | null = null;
  private _iframeDocuments = new Set<Document>();
  private _iframeLoadHandlers = new Map<
    HTMLIFrameElement,
    (event: Event) => void
  >();
  private _keyDownHandler:
    | ((this: Document, ev: DocumentEventMap["keydown"]) => void)
    | null = null;
  private _inputHandler:
    | ((this: Document, ev: DocumentEventMap["input"]) => void)
    | null = null;
  private _iframeObserver: MutationObserver | null = null;
  private _cacheRebuildTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly DOUBLE_KEY_TIMEOUT = 500;
  private static readonly POPUP_Y_OFFSET = 20;

  constructor(searchService: NoteSearchService, linkInserter: LinkInserter) {
    this.searchService = searchService;
    this.linkInserter = linkInserter;
  }

  async initialize(): Promise<void> {
    await this.searchService.buildCache();
    this.registerNotifyListeners();
    this.registerKeyboardListener();
    Zotero.debug("[FastLink] Note link autocomplete initialized");
  }

  private registerNotifyListeners(): void {
    const notifierID = Zotero.Notifier.registerObserver(
      {
        notify: async (event: string, type: string) => {
          if (type !== "item") return;
          for (const op of event.split(",")) {
            if (
              op === "add" ||
              op === "modify" ||
              op === "delete" ||
              op === "trash"
            ) {
              if (this._cacheRebuildTimer)
                clearTimeout(this._cacheRebuildTimer);
              this._cacheRebuildTimer = setTimeout(
                async () => {
                  this.searchService.clearCache();
                  await this.searchService.buildCache();
                  this._cacheRebuildTimer = null;
                },
                this.isActive ? 2000 : 500,
              );
              break;
            }
          }
        },
      },
      ["item"],
      "fastlink-autocomplete",
    );
    this._notifierID = notifierID;
  }

  private registerKeyboardListener(): void {
    this._keyDownHandler = this.handleKeyDown.bind(this);
    this._inputHandler = this.handleInput.bind(this);

    const mainWindow = Zotero.getMainWindow();
    this._editorDocument = mainWindow.document;

    this._editorDocument.addEventListener(
      "keydown",
      this._keyDownHandler,
      true,
    );
    this._editorDocument.addEventListener("input", this._inputHandler, true);

    this.attachToEditorIframes();

    // Watch for new iframes with debounced callback
    let iframeTimer: ReturnType<typeof setTimeout> | null = null;
    const iframeObserver = new mainWindow.MutationObserver(() => {
      if (iframeTimer) return;
      iframeTimer = setTimeout(() => {
        iframeTimer = null;
        this.attachToEditorIframes();
      }, 100);
    });
    iframeObserver.observe(mainWindow.document, {
      childList: true,
      subtree: true,
    });
    this._iframeObserver = iframeObserver;
  }

  private attachToEditorIframes(): void {
    if (!this._keyDownHandler || !this._inputHandler) return;

    const mainWindow = Zotero.getMainWindow();
    const iframes = mainWindow.document.querySelectorAll("iframe");

    for (const iframe of iframes) {
      try {
        const iframeEl = iframe as HTMLIFrameElement;
        if (this._iframeLoadHandlers.has(iframeEl)) continue;

        this.tryAttachToIframeDoc(iframeEl);

        const loadHandler = () => {
          this.tryAttachToIframeDoc(iframeEl);
        };
        iframeEl.addEventListener("load", loadHandler);
        this._iframeLoadHandlers.set(iframeEl, loadHandler);
      } catch {
        /* skip */
      }
    }
  }

  private tryAttachToIframeDoc(iframeEl: HTMLIFrameElement): void {
    try {
      const iframeDoc = iframeEl.contentDocument;
      if (!iframeDoc || (iframeDoc as any)._fastLinkAttached) return;
      (iframeDoc as any)._fastLinkAttached = true;

      iframeDoc.addEventListener("keydown", this._keyDownHandler!, true);
      iframeDoc.addEventListener("input", this._inputHandler!, true);
      this._iframeDocuments.add(iframeDoc);
    } catch {
      /* cross-origin */
    }
  }

  private handleKeyDown(event: Event): void {
    try {
      const keyEvent = event as KeyboardEvent;
      const target = event.target as HTMLElement;
      if (!target?.isContentEditable) return;

      // Capture the editor window from the event (works in iframe context)
      const doc = target.ownerDocument;
      if (doc?.defaultView) {
        this._lastEditorWindow = doc.defaultView;
        setCachedEditorWindow(doc.defaultView);
      }

      // Handle popup navigation
      if (this.popupController?.isVisible()) {
        if (this.popupController.handleKeyDown(keyEvent)) {
          event.stopPropagation();
          event.preventDefault();
          return;
        }
      }

      if (keyEvent.key === "Escape" && this.isActive) {
        this.closePopup();
        event.preventDefault();
        return;
      }

      // Check both key and code — IME (e.g. Chinese input) reports key="Process" instead of "["
      const isBracket = keyEvent.key === "[" || keyEvent.code === "BracketLeft";
      if (isBracket) {
        const now = Date.now();
        if (
          now - this.lastKeyTime < NoteLinkAutocomplete.DOUBLE_KEY_TIMEOUT &&
          this.triggerBuffer === "["
        ) {
          Zotero.debug("[FastLink] Double [[ detected");
          this.saveCursorPosition();
          this.triggerAutocomplete();
          this.triggerBuffer = "";
          keyEvent.stopPropagation();
        } else {
          this._triggerTarget = target;
          this.triggerBuffer = "[";
          this.lastKeyTime = now;
        }
      } else {
        this.triggerBuffer = "";
        this._triggerTarget = null;
      }
    } catch (error) {
      Zotero.debug(`[FastLink] Error in handleKeyDown: ${error}`);
    }
  }

  private handleInput(event: Event): void {
    const target = event.target as HTMLElement;
    if (!target?.isContentEditable) return;

    // If autocomplete is active, update query and search results
    if (this.isActive && this.popupController?.isVisible()) {
      this.linkInserter.saveSelection(
        target.ownerDocument?.defaultView || null,
      );
      const query = this.getQueryText();
      if (query !== null) {
        const results = this.searchService.search(query);
        this.popupController.setItems(this.mapResultsToPopupItems(results));
        this.popupController.updateQuery(query);
      }
      return;
    }

    // Backup detection: Check for [[ in the text content
    try {
      const doc = target.ownerDocument;
      if (!doc) return;

      const selection = doc.defaultView?.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);
      const textContent =
        range.startContainer.textContent?.substring(0, range.startOffset) || "";

      if (textContent.endsWith("[[") && !this.isActive) {
        Zotero.debug("[FastLink] Detected [[ via input event (backup)");
        this.triggerAutocomplete();
      }
    } catch (e) {
      Zotero.debug(`[FastLink] Error in input handler backup detection: ${e}`);
    }
  }

  private triggerAutocomplete(): void {
    this.isActive = true;

    this.linkInserter.saveSelection();

    if (!this.popupController) {
      this.popupController = new PopupController({
        onSelection: this.handleSelection.bind(this),
        onClose: this.handleClose.bind(this),
      });
    }

    const position = this.getCursorPosition();
    if (position) {
      const results = this.searchService.search("");
      this.popupController.setItems(this.mapResultsToPopupItems(results));
      this.popupController.show(
        position.x,
        position.y + NoteLinkAutocomplete.POPUP_Y_OFFSET,
      );
    } else {
      Zotero.debug(
        "[FastLink] Failed to get cursor position, not showing popup",
      );
      this.isActive = false;
    }
  }

  private async handleSelection(
    noteId: number | null,
    noteTitle: string,
    searchQuery: string,
  ): Promise<void> {
    // Capture live HTML and source note ID NOW before any async work
    // (e.g. createNote) that may change the editor to a different note.
    const editorWin = this._lastEditorWindow || getEditorWindow();
    const liveHtml = editorWin
      ? String(editorWin.document.body!.innerHTML)
      : "";
    const sourceNote = getCurrentNote();
    const sourceNoteId = sourceNote?.id;

    if (!sourceNoteId) {
      Zotero.debug(
        `[FastLink] handleSelection: could not determine source note — liveHtml length=${liveHtml.length}, editorWin=${!!editorWin}`,
      );
    }

    this.popupController?.hide();
    this.isActive = false;

    let linkText = noteTitle.trim();
    let targetNoteId = noteId;

    if (noteId !== null) {
      try {
        const note = await Zotero.Items.getAsync(noteId);
        if (note) {
          linkText = note.getNoteTitle ? note.getNoteTitle() : noteTitle.trim();
        }
      } catch {
        /* use default title */
      }
    } else if (searchQuery.trim()) {
      const libraryID = sourceNote?.libraryID || Zotero.Libraries.userLibraryID;
      const newNote = await createNote(libraryID, searchQuery.trim());
      if (newNote) {
        targetNoteId = newNote.id;
        linkText = searchQuery.trim();
      }

      // Wait for Zotero's editor auto-save to complete before modifying
      // the source note. createNote triggers an editor switch in the
      // side column, which auto-saves the source note to the DB.
      // Without this delay, our insertLink saveTx races with the
      // editor auto-save, and the last writer wins — overwriting the link.
      if (sourceNoteId) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    if (targetNoteId !== null) {
      await this.linkInserter.insertLink({
        noteId: targetNoteId,
        noteTitle: linkText,
        triggerText: searchQuery,
        liveHtml,
        sourceNoteId,
      });
    }
  }

  private handleClose(): void {
    this.isActive = false;
  }

  private closePopup(): void {
    this.popupController?.hide();
    this.isActive = false;
  }

  private saveCursorPosition(): void {
    try {
      const editorWin = this._lastEditorWindow || getEditorWindow();
      if (!editorWin) return;

      let offsetX = 0;
      let offsetY = 0;

      if (editorWin !== Zotero.getMainWindow()) {
        const match = getIframeByWindow(editorWin);
        if (match) {
          offsetX = match.rect.left;
          offsetY = match.rect.top;
        }
      }

      const selection = editorWin.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        let rect = range.getBoundingClientRect();

        // Collapsed selections return (0,0,0,0) — use temp marker
        if (rect.width === 0 && rect.height === 0) {
          try {
            const marker = editorWin.document.createElement("span");
            marker.textContent = "\u200b";
            const insertRange = range.cloneRange();
            insertRange.collapse(true);
            insertRange.insertNode(marker);
            rect = marker.getBoundingClientRect();
            marker.parentNode?.removeChild(marker);
          } catch {
            /* ignore */
          }
        }

        this._savedCursorPos = {
          x: rect.left + offsetX,
          y: rect.bottom + offsetY,
        };
        return;
      }

      // Fallback: trigger target position
      if (this._triggerTarget) {
        const rect = this._triggerTarget.getBoundingClientRect();
        this._savedCursorPos = {
          x: rect.left + offsetX + 20,
          y: rect.top + offsetY + rect.height / 2,
        };
      }
    } catch (e) {
      Zotero.debug(`[FastLink] saveCursorPosition error: ${e}`);
    }
  }

  private getCursorPosition(): { x: number; y: number } | null {
    if (this._savedCursorPos) {
      const pos = this._savedCursorPos;
      this._savedCursorPos = null;
      return pos;
    }
    return { x: 100, y: 200 };
  }

  private getQueryText(): string | null {
    try {
      const editorWin =
        this._lastEditorWindow ||
        this.linkInserter.getSavedWindow() ||
        getEditorWindow();
      if (!editorWin) return null;

      const body = editorWin.document.body;
      if (!body) return null;

      const selection = editorWin.getSelection();
      if (!selection || selection.rangeCount === 0) return null;

      const range = selection.getRangeAt(0);
      const prefixRange = range.cloneRange();
      prefixRange.selectNodeContents(body);
      prefixRange.setEnd(range.endContainer, range.endOffset);

      const textBeforeCaret = prefixRange.toString();
      const triggerIndex = textBeforeCaret.lastIndexOf("[[");
      if (triggerIndex < 0) return null;

      const query = textBeforeCaret.slice(triggerIndex + 2);
      if (/[\r\n]/.test(query)) return null;

      return query;
    } catch {
      return null;
    }
  }

  private mapResultsToPopupItems(results: SearchResult[]): PopupItem[] {
    return results.slice(0, 10).map((result) => ({
      noteId: result.note.id,
      title: result.note.title,
      matchType: result.matchType,
    }));
  }

  destroy(): void {
    if (this._notifierID) {
      Zotero.Notifier.unregisterObserver(this._notifierID);
    }

    if (this._editorDocument) {
      if (this._keyDownHandler)
        this._editorDocument.removeEventListener(
          "keydown",
          this._keyDownHandler,
          true,
        );
      if (this._inputHandler)
        this._editorDocument.removeEventListener(
          "input",
          this._inputHandler,
          true,
        );
    }

    for (const iframeDoc of this._iframeDocuments) {
      if (this._keyDownHandler)
        iframeDoc.removeEventListener("keydown", this._keyDownHandler, true);
      if (this._inputHandler)
        iframeDoc.removeEventListener("input", this._inputHandler, true);
    }
    this._iframeDocuments.clear();

    for (const [iframeEl, loadHandler] of this._iframeLoadHandlers.entries()) {
      iframeEl.removeEventListener("load", loadHandler);
    }
    this._iframeLoadHandlers.clear();

    this._iframeObserver?.disconnect();
    this._iframeObserver = null;

    if (this._cacheRebuildTimer) {
      clearTimeout(this._cacheRebuildTimer);
      this._cacheRebuildTimer = null;
    }

    this.popupController?.destroy();
  }
}

/**
 * Shared note creation utility.
 */
export async function createNote(
  libraryID: number,
  title: string,
): Promise<Zotero.Item | null> {
  try {
    const newNote = new Zotero.Item("note");
    newNote.libraryID = libraryID;
    // Use plain text so noteToTitle() extracts the title correctly.
    // noteToTitle() finds the first line by looking for newlines after
    // block-element closing tags - wrapping in <h1> breaks this.
    newNote.setNote(escapeHtml(title.trim()));
    await newNote.saveTx();
    Zotero.debug(
      `[FastLink] Created note id=${newNote.id}, title="${title}", noteContent="${newNote.getNote()}", extractedTitle="${newNote.getNoteTitle()}"`,
    );
    return newNote;
  } catch (e) {
    Zotero.debug(`[FastLink] Error creating note: ${e}`);
    return null;
  }
}
