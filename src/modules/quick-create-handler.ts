// src/modules/quick-create-handler.ts
import { LinkInserter } from "./link-inserter";
import { NoteSearchService } from "./note-search-service";
import { createNote } from "./note-link-autocomplete";
import { getCurrentNote } from "../utils/editor-detector";

export class QuickCreateHandler {
  private searchService: NoteSearchService;
  private linkInserter: LinkInserter;

  constructor(searchService: NoteSearchService, linkInserter: LinkInserter) {
    this.searchService = searchService;
    this.linkInserter = linkInserter;
  }

  async initialize(): Promise<void> {
    // Cache is already built by shared NoteSearchService instance
    this.registerShortcut();
  }

  private registerShortcut(): void {
    // Cache is already built by shared NoteSearchService instance
  }

  async handleQuickCreate(): Promise<void> {
    const win = Zotero.getMainWindow();
    this.linkInserter.saveSelection();

    const currentNote = getCurrentNote();
    const libraryID = currentNote?.libraryID || Zotero.Libraries.userLibraryID;

    const defaultTitle = this.generateDefaultTitle();

    const query = win.prompt(
      `Enter note title or keywords:\n\n` +
        `Type to search existing notes\n` +
        `Press Enter to create with default title "${defaultTitle}"`,
      defaultTitle,
    );

    if (query === null) return;

    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;

    const result = await this.searchAndSelect(trimmedQuery);
    if (result.action === "cancel") return;

    let targetNote: Zotero.Item | null = null;
    let isReused = false;

    if (result.action === "reuse" && result.noteId) {
      targetNote = Zotero.Items.get(result.noteId);
      isReused = true;
    } else {
      targetNote = await createNote(libraryID, result.title);
    }

    if (targetNote) {
      const inserted = await this.linkInserter.insertLink({
        noteId: targetNote.id,
        noteTitle: result.title,
        sourceNoteId: currentNote?.id,
      });

      if (!inserted) {
        await this.linkInserter.copyLinkToClipboard(
          targetNote.id,
          result.title,
        );
      }
    }
  }

  private async searchAndSelect(query: string): Promise<{
    action: "create" | "reuse" | "cancel";
    noteId?: number;
    title: string;
  }> {
    const win = Zotero.getMainWindow();
    const results = this.searchService.search(query);

    if (results.length === 0) {
      return { action: "create", title: query };
    }

    let message = `Search: "${query}"\n──────────────────\n`;
    for (let i = 0; i < Math.min(results.length, 10); i++) {
      const result = results[i];
      const matchIcon = result.matchType === "exact" ? "✓" : "≈";
      message += `${matchIcon} ${i + 1}. ${result.note.title}\n`;
    }
    message += `──────────────────\n`;
    message += `Enter number (1-${Math.min(results.length, 10)}) or press Enter to create new`;

    const selection = win.prompt(message, "");
    if (selection === null) return { action: "cancel", title: query };

    const selectedIndex = parseInt(selection);
    if (
      !isNaN(selectedIndex) &&
      selectedIndex >= 1 &&
      selectedIndex <= results.length
    ) {
      const result = results[selectedIndex - 1];
      return {
        action: "reuse",
        noteId: result.note.id,
        title: result.note.title,
      };
    }

    return { action: "create", title: query };
  }

  private generateDefaultTitle(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  destroy(): void {}
}
