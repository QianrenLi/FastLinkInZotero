// src/modules/quick-create-handler.ts
import { NoteSearchService, SearchResult } from './note-search-service';
import { LinkInserter } from './link-inserter';
import { getActiveEditor, getCurrentNote } from '../utils/editor-detector';

export class QuickCreateHandler {
  private searchService: NoteSearchService;
  private linkInserter: LinkInserter;

  constructor() {
    this.searchService = new NoteSearchService();
    this.linkInserter = new LinkInserter();
  }

  /**
   * Initialize the handler
   */
  async initialize(): Promise<void> {
    await this.searchService.buildCache();
    this.registerShortcut();
  }

  /**
   * Register Ctrl+N shortcut
   * Note: This is a placeholder. Actual shortcut registration happens in hooks.ts
   */
  private registerShortcut(): void {
    // Use zotero-plugin-toolkit to register shortcut
    // This will be called from hooks.ts
    Zotero.debug('[FastLink] Quick create handler registered');
  }

  /**
   * Handle quick note creation
   */
  async handleQuickCreate(): Promise<void> {
    const win = Zotero.getMainWindow();
    const currentNote = getCurrentNote();
    const libraryID = currentNote?.libraryID || Zotero.Libraries.userLibraryID;

    // Generate default title
    const defaultTitle = this.generateDefaultTitle();

    // Show prompt for note title
    const query = win.prompt(
      `🔍 Enter note title or keywords:\n\n` +
      `• Type to search existing notes\n` +
      `• Press Enter to create with default title "${defaultTitle}"`,
      defaultTitle
    );

    if (query === null) return; // User cancelled

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      win.alert('Title cannot be empty');
      return;
    }

    // Search for matching notes
    const result = await this.searchAndSelect(libraryID, trimmedQuery);

    if (result.action === 'cancel') return;

    let targetNote: Zotero.Item | null = null;
    let finalTitle = result.title;
    let isReused = false;

    if (result.action === 'reuse' && result.noteId) {
      targetNote = Zotero.Items.get(result.noteId);
      isReused = true;
    } else {
      // Create new note
      targetNote = await this.createNewNote(libraryID, finalTitle);
    }

    if (targetNote) {
      // Insert link
      const inserted = await this.linkInserter.insertLink({
        noteId: targetNote.id,
        noteTitle: finalTitle,
      });

      if (!inserted) {
        // Fallback: copy to clipboard
        await this.linkInserter.copyLinkToClipboard(targetNote.id, finalTitle);
        const action = isReused ? 'Reused' : 'Created';
        win.alert(`${action} "${finalTitle}". Link copied to clipboard.`);
      } else {
        Zotero.debug(`[FastLink] ${isReused ? 'Reused' : 'Created'}: ${finalTitle}`);
      }
    }
  }

  /**
   * Search and select note
   */
  private async searchAndSelect(
    libraryID: number,
    query: string
  ): Promise<{ action: 'create' | 'reuse' | 'cancel'; noteId?: number; title: string }> {
    const win = Zotero.getMainWindow();
    const results = this.searchService.search(query);

    if (results.length === 0) {
      return { action: 'create', title: query };
    }

    // Build selection message
    let message = `🔍 Search: "${query}"\n`;
    message += `──────────────────\n`;

    for (let i = 0; i < Math.min(results.length, 10); i++) {
      const result = results[i];
      const matchIcon = result.matchType === 'exact' ? '✓' : '≈';
      message += `${matchIcon} ${i + 1}. ${result.note.title}\n`;
    }

    message += `──────────────────\n`;
    message += `Enter number (1-${Math.min(results.length, 10)}) or press Enter to create new`;

    const selection = win.prompt(message, '');

    if (selection === null) {
      return { action: 'cancel', title: query };
    }

    const selectedIndex = parseInt(selection);
    if (!isNaN(selectedIndex) && selectedIndex >= 1 && selectedIndex <= results.length) {
      const result = results[selectedIndex - 1];
      return { action: 'reuse', noteId: result.note.id, title: result.note.title };
    }

    return { action: 'create', title: query };
  }

  /**
   * Create a new note
   */
  private async createNewNote(libraryID: number, title: string): Promise<Zotero.Item | null> {
    try {
      // Create note in the specified library using asyncCreate
      const noteData = {
        itemType: 'note',
        libraryID: libraryID
      };
      const newNote = await Zotero.Items.asyncCreate(noteData);

      if (!newNote) {
        throw new Error('Failed to create note');
      }

      // Set note title via HTML content
      const escapedTitle = this.escapeHtml(title);
      const html = `<h1>${escapedTitle}</h1><p></p>`;

      // Use Zotero's API to set note content
      if (newNote.setNote) {
        newNote.setNote(html);
        await newNote.saveTx();
      }

      // Add to Quick Note collection
      await this.addToQuickNoteCollection(newNote, libraryID);

      Zotero.debug(`[FastLink] Created new note: ${title}`);
      return newNote;
    } catch (e) {
      Zotero.debug(`[FastLink] Error creating note: ${e}`);
      return null;
    }
  }

  /**
   * Add note to Quick Note collection
   */
  private async addToQuickNoteCollection(note: Zotero.Item, libraryID: number): Promise<void> {
    try {
      const collections = Zotero.Collections.getByLibrary(libraryID);
      let quickNoteCol = collections.find(c => c.name === 'Quick Note');

      if (!quickNoteCol) {
        // Create collection in the specified library
        // Use type assertion to handle libraryID assignment
        const newCollection = new Zotero.Collection();
        (newCollection as any).libraryID = libraryID;
        newCollection.name = 'Quick Note';
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

  /**
   * Generate default title based on timestamp
   */
  private generateDefaultTitle(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }

  /**
   * Escape HTML for safe insertion
   * Uses Zotero.getMainWindow().document instead of global document
   */
  private escapeHtml(text: string): string {
    const win = Zotero.getMainWindow();
    const div = win.document.createElement('div');
    div.textContent = text;
    // Cast to string to handle TrustedHTML type
    return div.innerHTML as string;
  }

  /**
   * Destroy the handler and clean up resources
   *
   * This method is provided for API consistency with NoteLinkAutocomplete.
   * QuickCreateHandler does not register any event listeners or hold
   * resources that require cleanup, so this method is currently empty.
   * It exists for future-proofing and to maintain a consistent interface
   * across all FastLink components.
   */
  destroy(): void {
    // No resources to clean up currently
    // This method exists for API consistency
  }
}
