// src/modules/note-link-autocomplete.ts
import { NoteSearchService, SearchResult } from './note-search-service';
import { PopupController, PopupItem } from './popup-controller';
import { LinkInserter } from './link-inserter';
import { getActiveEditor, isInLinkElement } from '../utils/editor-detector';

export class NoteLinkAutocomplete {
  private searchService: NoteSearchService;
  private popupController: PopupController | null = null;
  private linkInserter: LinkInserter;
  private isActive = false;
  private triggerBuffer = '';
  private lastKeyTime = 0;

  // Event listener cleanup references
  private _notifierID: string | null = null;
  private _keyPressHandler: ((this: Document, ev: DocumentEventMap['keypress']) => void) | null = null;
  private _keyDownHandler: ((this: Document, ev: DocumentEventMap['keydown']) => void) | null = null;
  private _inputHandler: ((this: Document, ev: DocumentEventMap['input']) => void) | null = null;

  // Hard-coded constants
  private static readonly DOUBLE_KEY_TIMEOUT = 500;
  private static readonly POPUP_Y_OFFSET = 20;

  constructor() {
    this.searchService = new NoteSearchService();
    this.linkInserter = new LinkInserter();
  }

  /**
   * Initialize the autocomplete system
   */
  async initialize(): Promise<void> {
    await this.searchService.buildCache();

    // Register Zotero notify listeners for cache updates
    this.registerNotifyListeners();

    // Register keyboard listener
    this.registerKeyboardListener();

    Zotero.debug('[FastLink] Note link autocomplete initialized');
  }

  /**
   * Register Zotero item change listeners
   */
  private registerNotifyListeners(): void {
    const notifierID = Zotero.Notifier.registerObserver({
      notify: async (event: string, type: string, ids: string[] | number[], extraData: object | null) => {
        if (type === 'item') {
          const operations = event.split(',');
          for (const op of operations) {
            if (op === 'add' || op === 'modify' || op === 'delete' || op === 'trash') {
              // Rebuild cache when notes change
              this.searchService.clearCache();
              await this.searchService.buildCache();
              break;
            }
          }
        }
      }
    }, ['item'], 'fastlink-autocomplete');

    // Store notifier ID for cleanup
    this._notifierID = notifierID;
  }

  /**
   * Register keyboard listener for [[ trigger
   */
  private registerKeyboardListener(): void {
    const document = Zotero.getMainWindow().document;

    // Store bound methods BEFORE registration for proper cleanup
    this._keyPressHandler = this.handleKeyPress.bind(this);
    this._keyDownHandler = this.handleKeyDown.bind(this);
    this._inputHandler = this.handleInput.bind(this);

    // Null checks are guaranteed here since we just assigned them
    document.addEventListener('keypress', this._keyPressHandler!, true);
    document.addEventListener('keydown', this._keyDownHandler!, true);
    document.addEventListener('input', this._inputHandler!, true);
  }

  /**
   * Handle key press for [[ detection
   */
  private handleKeyPress(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    const editor = getActiveEditor();
    if (!editor) return;

    // Check if we're typing in the editor
    const target = event.target as Node;
    if (!editor.documentElement.contains(target)) return;

    const now = Date.now();

    // Check for [ key
    if (keyEvent.key === '[') {
      if (now - this.lastKeyTime < NoteLinkAutocomplete.DOUBLE_KEY_TIMEOUT && this.triggerBuffer === '[') {
        // Double [[ detected
        this.triggerAutocomplete();
        this.triggerBuffer = '';
      } else {
        this.triggerBuffer = '[';
        this.lastKeyTime = now;
      }
    } else if (keyEvent.key !== '[') {
      this.triggerBuffer = '';
    }
  }

  /**
   * Handle key down for popup navigation
   */
  private handleKeyDown(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    if (this.popupController?.isVisible()) {
      if (this.popupController.handleKeyDown(keyEvent)) {
        event.stopPropagation();
        event.preventDefault();
      }
    }

    // Close popup on Escape if no popup visible
    if (keyEvent.key === 'Escape' && this.isActive) {
      this.closePopup();
    }
  }

  /**
   * Handle input for filtering
   */
  private handleInput(event: Event): void {
    if (!this.isActive || !this.popupController?.isVisible()) return;

    const editor = getActiveEditor();
    if (!editor) return;

    // Get current text after [[
    const query = this.getQueryText();
    if (query !== null) {
      this.popupController.updateQuery(query);
    }
  }

  /**
   * Trigger autocomplete popup
   */
  private triggerAutocomplete(): void {
    if (isInLinkElement()) {
      Zotero.debug('[FastLink] Inside link element, not triggering');
      return;
    }

    this.isActive = true;

    // Create popup if needed
    if (!this.popupController) {
      this.popupController = new PopupController({
        onSelection: this.handleSelection.bind(this),
        onClose: this.handleClose.bind(this),
      });
    }

    // Position popup at cursor
    const position = this.getCursorPosition();
    if (position) {
      this.popupController.show(position.x, position.y + NoteLinkAutocomplete.POPUP_Y_OFFSET);

      // Show initial results
      const results = this.searchService.search('');
      this.popupController.setItems(this.mapResultsToPopupItems(results));
    }
  }

  /**
   * Handle selection from popup
   */
  private handleSelection(noteId: number | null, query: string): void {
    if (noteId !== null) {
      // Insert link to existing note
      this.linkInserter.removeTriggerText(2 + query.length);
      this.linkInserter.insertLink({ noteId, noteTitle: query });
    } else {
      // Create new note (handled by QuickCreateHandler)
      // For now, just close popup
      this.closePopup();
    }

    this.isActive = false;
  }

  /**
   * Handle popup close
   */
  private handleClose(): void {
    this.isActive = false;
  }

  /**
   * Close popup
   */
  private closePopup(): void {
    this.popupController?.hide();
    this.isActive = false;
  }

  /**
   * Get cursor position for popup
   */
  private getCursorPosition(): { x: number; y: number } | null {
    try {
      const win = Zotero.getMainWindow();
      const selection = win.getSelection();
      if (!selection || selection.rangeCount === 0) return null;

      const range = selection.getRangeAt(0);
      const rects = range.getClientRects();

      if (rects && rects.length > 0) {
        return {
          x: rects[0].left + win.scrollX,
          y: rects[0].bottom + win.scrollY,
        };
      }
    } catch (e) {
      Zotero.debug(`[FastLink] Error getting cursor position: ${e}`);
    }
    return null;
  }

  /**
   * Get query text after [[
   */
  private getQueryText(): string | null {
    try {
      const win = Zotero.getMainWindow();
      const selection = win.getSelection();
      if (!selection || selection.rangeCount === 0) return null;

      const range = selection.getRangeAt(0);
      const text = range.startContainer.textContent?.substring(0, range.startOffset) || '';

      // Find last [[
      const lastBracketIndex = text.lastIndexOf('[[');
      if (lastBracketIndex >= 0) {
        return text.substring(lastBracketIndex + 2);
      }
    } catch (e) {
      Zotero.debug(`[FastLink] Error getting query text: ${e}`);
    }
    return null;
  }

  /**
   * Map search results to popup items
   */
  private mapResultsToPopupItems(results: SearchResult[]): PopupItem[] {
    return results.slice(0, 10).map(result => ({
      noteId: result.note.id,
      title: result.note.title,
      matchType: result.matchType,
    }));
  }

  /**
   * Clean up
   */
  destroy(): void {
    if (this._notifierID) {
      Zotero.Notifier.unregisterObserver(this._notifierID);
    }

    const document = Zotero.getMainWindow().document;
    if (this._keyPressHandler) {
      document.removeEventListener('keypress', this._keyPressHandler, true);
    }
    if (this._keyDownHandler) {
      document.removeEventListener('keydown', this._keyDownHandler, true);
    }
    if (this._inputHandler) {
      document.removeEventListener('input', this._inputHandler, true);
    }

    this.popupController?.destroy();
  }
}
