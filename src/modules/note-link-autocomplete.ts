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
import { debounce, type DebouncedFunction } from "../utils/debounce";

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
  private _cacheUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingItemIds = new Set<number>();

  /**
   * Debounced search+render. Coalesces rapid keystrokes into a single cache
   * scan and popup render so typing stays responsive. The pending call is
   * flushed immediately when the user navigates (arrows/Enter/Tab) so selects
   * always act on results for the latest query.
   */
  private _debouncedSearch: DebouncedFunction<(query: string) => void>;

  private static readonly DOUBLE_KEY_TIMEOUT = 500;
  private static readonly POPUP_Y_OFFSET = 20;
  private static readonly SEARCH_DEBOUNCE_MS = 60;
  private static readonly QUERY_BACK_BUDGET = 512;
  private static readonly NAV_KEYS = new Set([
    "ArrowDown",
    "ArrowUp",
    "Enter",
    "Tab",
  ]);

  constructor(searchService: NoteSearchService, linkInserter: LinkInserter) {
    this.searchService = searchService;
    this.linkInserter = linkInserter;
    this._debouncedSearch = debounce((query: string) => {
      this.runSearch(query);
    }, NoteLinkAutocomplete.SEARCH_DEBOUNCE_MS);
  }

  async initialize(): Promise<void> {
    await this.searchService.buildCache();
    this.registerNotifyListeners();
    this.registerKeyboardListener();
    Zotero.debug("[FastLink] Initialized");
  }

  private registerNotifyListeners(): void {
    const notifierID = Zotero.Notifier.registerObserver(
      {
        notify: async (
          event: string,
          type: string,
          ids: Array<string | number>,
        ) => {
          if (type !== "item") return;
          const relevant = event
            .split(",")
            .some(
              (op) =>
                op === "add" ||
                op === "modify" ||
                op === "delete" ||
                op === "trash",
            );
          if (!relevant) return;

          // Batch the changed ids and reconcile them incrementally instead of
          // rebuilding the whole cache. Coalescing within the debounce window
          // means a burst of autosave notifies collapses into one small update.
          for (const id of ids) this._pendingItemIds.add(Number(id));

          if (this._cacheUpdateTimer) clearTimeout(this._cacheUpdateTimer);
          this._cacheUpdateTimer = setTimeout(
            async () => {
              const pending = Array.from(this._pendingItemIds);
              this._pendingItemIds.clear();
              this._cacheUpdateTimer = null;
              await this.searchService.updateItems(pending);
            },
            this.isActive ? 2000 : 500,
          );
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
        // Make sure the list reflects the latest query before the user
        // navigates/selects — otherwise a fast type-then-Enter could select
        // against stale results.
        if (NoteLinkAutocomplete.NAV_KEYS.has(keyEvent.key)) {
          this._debouncedSearch.flush();
        }
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
      // Keep the saved selection fresh on every keystroke so link insertion
      // later targets the right caret position. This is cheap (a cloned
      // Range) and must stay synchronous.
      this.linkInserter.saveSelection(
        target.ownerDocument?.defaultView || null,
      );
      const query = this.getQueryText();
      if (query !== null) {
        this.scheduleSearch(query);
      }
      return;
    }

    // Backup detection for "[[" arriving without two bracket keydowns (paste,
    // some IME paths). Only pay for the selection/range work when the inserted
    // text actually contains a "[", so ordinary typing in a note is free here.
    const data = (event as InputEvent).data;
    if (!data || !data.includes("[")) return;

    try {
      const doc = target.ownerDocument;
      if (!doc) return;

      const selection = doc.defaultView?.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);
      const textContent =
        range.startContainer.textContent?.substring(0, range.startOffset) || "";

      if (textContent.endsWith("[[") && !this.isActive) {
        this.triggerAutocomplete();
      }
    } catch (e) {
      Zotero.debug(`[FastLink] Error in input handler backup detection: ${e}`);
    }
  }

  /**
   * Track the latest query synchronously (cheap — keeps the Create-option and
   * selection logic correct instantly) and schedule one debounced search+render
   * so a burst of keystrokes collapses into a single cache scan.
   */
  private scheduleSearch(query: string): void {
    this.popupController?.updateQuery(query);
    this._debouncedSearch(query);
  }

  private runSearch(query: string): void {
    if (!this.popupController?.isVisible()) return;
    const results = this.searchService.search(query);
    this.popupController.setSearchResults(
      this.mapResultsToPopupItems(results),
      query,
    );
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
      // Show first so the popup element + inner container exist, then render
      // results into it. Rendering before the first show() would no-op (the
      // container is created lazily inside show()) and leave the popup empty
      // on the first trigger of a session.
      this.popupController.show(
        position.x,
        position.y + NoteLinkAutocomplete.POPUP_Y_OFFSET,
      );
      const results = this.searchService.search("");
      this.popupController.setSearchResults(
        this.mapResultsToPopupItems(results),
        "",
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
        "[FastLink] handleSelection: could not determine source note",
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
      // Notes created from "[[" start with a first-level heading ("#" in the
      // rendered note), matching the Obsidian-style convention.
      const newNote = await createNote(libraryID, searchQuery.trim(), {
        withHeading: true,
      });
      if (newNote) {
        targetNoteId = newNote.id;
        linkText = searchQuery.trim();
      }

      // Wait for Zotero's editor auto-save to complete before modifying
      // the source note. createNote triggers an editor switch in the
      // side column, which auto-saves the source note to the DB.
      // Without this delay, our insertLink saveTx races with the
      // editor auto-save, and the last writer wins — overwriting the link.
      // NOTE: the restore must be a SINGLE editor.item set AFTER Zotero has
      // finished switching to the new note. Re-asserting in a poll fights the
      // editor re-init (and Better Notes' re-patch on every switch) and never
      // stabilizes — see git history. The 300ms delay + slower two-save
      // createNote put this set safely past the switch churn.
      if (sourceNoteId) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        this.restoreEditorToNote(sourceNoteId);
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
    this._debouncedSearch.cancel();
  }

  private closePopup(): void {
    this._debouncedSearch.cancel();
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
      // Bound how far back we read: the query between "[[" and the caret is
      // short, so a small window is enough and we avoid serializing the whole
      // note body on every keystroke. Fall back to the whole body if bounding
      // fails for any reason (correctness matches the old behavior).
      try {
        const startNode = this.findBoundedRangeStart(
          range.startContainer,
          body,
          NoteLinkAutocomplete.QUERY_BACK_BUDGET,
        );
        prefixRange.setStart(startNode, 0);
      } catch {
        prefixRange.selectNodeContents(body);
      }
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

  /**
   * Find the text node to start the query range at, by walking backward from
   * the caret and accumulating text length up to `budget` chars. Returns a
   * node whose offset 0 marks the start of the bounded window. If there are
   * fewer than `budget` chars of text before the caret, returns the earliest
   * reachable text node (or the caret container if there is none).
   */
  private findBoundedRangeStart(
    caretContainer: Node,
    body: HTMLElement,
    budget: number,
  ): Node {
    const doc = body.ownerDocument!;
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    walker.currentNode = caretContainer;

    let collected = 0;
    let earliest: Node = caretContainer;
    let prev = walker.previousNode() as Text | null;
    while (prev && collected < budget) {
      collected += prev.length;
      earliest = prev;
      prev = walker.previousNode() as Text | null;
    }
    return earliest;
  }

  private mapResultsToPopupItems(results: SearchResult[]): PopupItem[] {
    return results.slice(0, 10).map((result) => ({
      noteId: result.note.id,
      title: result.note.title,
      matchType: result.matchType,
    }));
  }

  /**
   * Switch the side-column editor back to the source note with a SINGLE
   * `editor.item` set, called only after a delay that lets Zotero finish
   * switching to (and re-initializing the editor for) the newly created note.
   *
   * Why one set and not a poll: the `editor.item` setter re-initializes the
   * editor, and Better Notes re-patches it on every switch — so repeated
   * re-asserts during the switch churn fight each other and never stabilize.
   * A single set landing AFTER the churn is what sticks.
   */
  private restoreEditorToNote(noteId: number): void {
    try {
      const win = Zotero.getMainWindow();
      const tabType = win.Zotero_Tabs?.selectedType;

      if (tabType === "reader") {
        // Side-column editor: switch back to the source note
        const editor = win.ZoteroContextPane?.activeEditor;
        if (editor) {
          const item = Zotero.Items.get(noteId);
          if (item) {
            editor.mode = "edit";
            editor.item = item;
          }
        }
      }
    } catch (e) {
      Zotero.debug(`[FastLink] Error restoring editor focus: ${e}`);
    }
  }

  destroy(): void {
    this._debouncedSearch.cancel();

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

    if (this._cacheUpdateTimer) {
      clearTimeout(this._cacheUpdateTimer);
      this._cacheUpdateTimer = null;
    }
    this._pendingItemIds.clear();

    this.popupController?.destroy();
  }
}

/**
 * Shared note creation utility. Adds the note to the "Quick Note" collection.
 */
export async function createNote(
  libraryID: number,
  title: string,
  options?: { withHeading?: boolean },
): Promise<Zotero.Item | null> {
  try {
    const newNote = new Zotero.Item("note");
    newNote.libraryID = libraryID;
    const safeTitle = escapeHtml(title.trim());
    // Start the note with a first-level heading when requested (used by the
    // "[[" autocomplete flow). noteToTitle() still resolves the title
    // correctly: it appends a newline after block-element closing tags (the
    // regex covers <h1>..<h6>, <p>, <div>) and unescapeHTML() strips the tags,
    // so the first line is the plain title text.
    const content = options?.withHeading ? `<h1>${safeTitle}</h1>` : safeTitle;
    newNote.setNote(content);
    await newNote.saveTx();
    Zotero.debug(`[FastLink] Created note id=${newNote.id}, title="${title}"`);

    await addToQuickNoteCollection(newNote, libraryID);

    return newNote;
  } catch (e) {
    Zotero.debug(`[FastLink] Error creating note: ${e}`);
    return null;
  }
}

async function addToQuickNoteCollection(
  note: Zotero.Item,
  libraryID: number,
): Promise<void> {
  try {
    const collections = Zotero.Collections.getByLibrary(libraryID);
    let quickNoteCol = collections.find((c) => c.name === "Quick Note");

    if (!quickNoteCol) {
      const newCollection = new Zotero.Collection();
      (newCollection as any).libraryID = libraryID;
      newCollection.name = "Quick Note";
      await newCollection.saveTx();
      quickNoteCol = newCollection;
    }

    if (quickNoteCol) {
      note.addToCollection(quickNoteCol.id);
      await note.saveTx();
    }
  } catch (e) {
    Zotero.debug(`[FastLink] Error adding to Quick Note collection: ${e}`);
  }
}
