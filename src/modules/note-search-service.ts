export interface NoteInfo {
  id: number;
  title: string;
  lowerTitle: string; // pre-lowered for efficient search
  libraryID: number;
  dateAdded: Date;
}

export interface SearchResult {
  note: NoteInfo;
  matchType: "exact" | "prefix" | "contains";
}

export class NoteSearchService {
  private static cache: Map<number, NoteInfo> = new Map();
  private static recentNotes: NoteInfo[] = []; // pre-sorted by date
  private static cacheBuilt = false;
  private static buildPromise: Promise<void> | null = null;

  async buildCache(): Promise<void> {
    if (NoteSearchService.buildPromise) {
      await NoteSearchService.buildPromise;
      return;
    }

    NoteSearchService.buildPromise = this.doBuildCache();
    try {
      await NoteSearchService.buildPromise;
    } finally {
      NoteSearchService.buildPromise = null;
    }
  }

  private async doBuildCache(): Promise<void> {
    try {
      const s = new Zotero.Search();
      s.addCondition("itemType", "is", "note");
      const ids = await s.search();

      // Batch-load all items at once instead of N+1 individual calls
      const items = await Zotero.Items.getAsync(ids);

      NoteSearchService.cache.clear();
      for (const item of items) {
        try {
          if (!item?.isNote()) continue;
          if (item.parentID) continue;

          const title = item.getField("title") || "";
          if (!title) continue;

          NoteSearchService.cache.set(item.id, {
            id: item.id,
            title,
            lowerTitle: title.toLowerCase(),
            libraryID: item.libraryID,
            dateAdded: new Date(item.dateAdded),
          });
        } catch {
          // Skip items that aren't fully loaded yet
        }
      }

      // Pre-sort recent notes list
      NoteSearchService.recentNotes = Array.from(
        NoteSearchService.cache.values(),
      ).sort((a, b) => b.dateAdded.getTime() - a.dateAdded.getTime());

      NoteSearchService.cacheBuilt = true;
      Zotero.debug(
        `[FastLink] Built cache with ${NoteSearchService.cache.size} notes`,
      );
    } catch (e) {
      Zotero.debug(`[FastLink] Error building cache: ${e}`);
    }
  }

  search(query: string): SearchResult[] {
    if (!NoteSearchService.cacheBuilt) return [];

    const searchTerm = query.trim().toLowerCase();
    if (!searchTerm) return this.getRecentNotes(10);

    const results: SearchResult[] = [];
    for (const note of NoteSearchService.cache.values()) {
      if (note.lowerTitle === searchTerm) {
        results.push({ note, matchType: "exact" });
      } else if (note.lowerTitle.startsWith(searchTerm)) {
        results.push({ note, matchType: "prefix" });
      } else if (note.lowerTitle.includes(searchTerm)) {
        results.push({ note, matchType: "contains" });
      }
    }

    return this.rankResults(results);
  }

  private getRecentNotes(limit: number): SearchResult[] {
    return NoteSearchService.recentNotes
      .slice(0, limit)
      .map((note) => ({ note, matchType: "exact" as const }));
  }

  private rankResults(results: SearchResult[]): SearchResult[] {
    const matchTypeOrder = { exact: 0, prefix: 1, contains: 2 };
    return results.sort((a, b) => {
      const typeDiff =
        matchTypeOrder[a.matchType] - matchTypeOrder[b.matchType];
      if (typeDiff !== 0) return typeDiff;
      const dateDiff = b.note.dateAdded.getTime() - a.note.dateAdded.getTime();
      if (dateDiff !== 0) return dateDiff;
      return a.note.title.length - b.note.title.length;
    });
  }

  getNote(id: number): NoteInfo | undefined {
    return NoteSearchService.cache.get(id);
  }

  isCacheBuilt(): boolean {
    return NoteSearchService.cacheBuilt;
  }

  clearCache(): void {
    NoteSearchService.cacheBuilt = false;
    NoteSearchService.cache.clear();
    NoteSearchService.recentNotes = [];
  }
}
