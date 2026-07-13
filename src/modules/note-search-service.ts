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

  /**
   * Search cached notes by title. Results are ranked exact > prefix > contains,
   * and within each bucket by recency then title length.
   *
   * Performance: matches are bucketed by type so the (often large) `contains`
   * bucket only gets sorted when the higher-priority buckets can't fill the
   * limit — this is the hot path called on every keystroke while typing.
   */
  search(query: string, limit = 10): SearchResult[] {
    if (!NoteSearchService.cacheBuilt) return [];

    const searchTerm = query.trim().toLowerCase();
    if (!searchTerm) return this.getRecentNotes(limit);

    const exact: SearchResult[] = [];
    const prefix: SearchResult[] = [];
    const contains: SearchResult[] = [];

    for (const note of NoteSearchService.cache.values()) {
      const lt = note.lowerTitle;
      if (lt === searchTerm) {
        exact.push({ note, matchType: "exact" });
      } else if (lt.startsWith(searchTerm)) {
        prefix.push({ note, matchType: "prefix" });
      } else if (lt.includes(searchTerm)) {
        contains.push({ note, matchType: "contains" });
      }
    }

    const sortByRank = (a: SearchResult, b: SearchResult): number => {
      const dateDiff = b.note.dateAdded.getTime() - a.note.dateAdded.getTime();
      if (dateDiff !== 0) return dateDiff;
      return a.note.title.length - b.note.title.length;
    };

    exact.sort(sortByRank);
    prefix.sort(sortByRank);

    // Concatenating buckets in priority order yields the same ordering as a
    // global sort by (matchType, date, length).
    const ranked = [...exact, ...prefix];

    // Only pay for sorting the contains bucket if we actually need it to fill
    // the visible list — the common case is that exact+prefix already cover it.
    if (ranked.length < limit) {
      contains.sort(sortByRank);
      ranked.push(...contains);
    }

    return ranked.slice(0, limit);
  }

  private getRecentNotes(limit: number): SearchResult[] {
    return NoteSearchService.recentNotes
      .slice(0, limit)
      .map((note) => ({ note, matchType: "exact" as const }));
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
