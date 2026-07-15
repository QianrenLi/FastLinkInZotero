export interface NoteInfo {
  id: number;
  title: string;
  lowerTitle: string; // pre-lowered for efficient search
  libraryID: number;
  dateAdded: Date;
  dateAddedMs: number; // numeric timestamp for cheap comparison
}

export interface SearchResult {
  note: NoteInfo;
  matchType: "exact" | "prefix" | "contains";
}

export class NoteSearchService {
  private static cache: Map<number, NoteInfo> = new Map();
  private static recentNotes: NoteInfo[] = []; // pre-sorted by date
  private static recentNotesDirty = false; // recentNotes needs recompute
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
        const info = this.buildNoteInfo(item);
        if (info) NoteSearchService.cache.set(info.id, info);
      }

      // Pre-sort recent notes list
      NoteSearchService.recentNotes = Array.from(
        NoteSearchService.cache.values(),
      ).sort((a, b) => b.dateAddedMs - a.dateAddedMs);
      NoteSearchService.recentNotesDirty = false;

      NoteSearchService.cacheBuilt = true;
      Zotero.debug(
        `[FastLink] Built cache with ${NoteSearchService.cache.size} notes`,
      );
    } catch (e) {
      Zotero.debug(`[FastLink] Error building cache: ${e}`);
    }
  }

  /**
   * Incrementally reconcile the cache for a small set of changed item IDs,
   * instead of rebuilding from the DB. Called from the Notifier observer on
   * add/modify/delete/trash. `Zotero.Items.getAsync` excludes deleted/trashed
   * items by default, so any requested id missing from the result is removed.
   */
  async updateItems(ids: number[]): Promise<void> {
    if (!NoteSearchService.cacheBuilt || ids.length === 0) return;

    try {
      const items = (await Zotero.Items.getAsync(ids)) as Zotero.Item[];
      const fetched = new Set<number>();
      for (const item of items) {
        fetched.add(item.id);
        const info = this.buildNoteInfo(item);
        if (info) {
          // Skip cache write if the title hasn't changed — avoids churning
          // the Map on every autosave cycle for notes whose content changed
          // but whose title (first line) stayed the same.
          const existing = NoteSearchService.cache.get(info.id);
          if (
            existing &&
            existing.title === info.title &&
            existing.libraryID === info.libraryID
          ) {
            continue;
          }
          NoteSearchService.cache.set(info.id, info);
        } else {
          // No longer cacheable (lost its title, gained a parent, etc.)
          NoteSearchService.cache.delete(item.id);
        }
      }
      // Any id we asked for that wasn't returned is gone/trashed — drop it.
      for (const id of ids) {
        if (!fetched.has(id)) NoteSearchService.cache.delete(id);
      }
      NoteSearchService.recentNotesDirty = true;
      Zotero.debug(
        `[FastLink] Updated ${ids.length} item(s); cache size ${NoteSearchService.cache.size}`,
      );
    } catch (e) {
      Zotero.debug(`[FastLink] Error updating cache: ${e}`);
    }
  }

  /**
   * Map a note item to a cache entry, or null if it doesn't qualify
   * (not a note, is a child note, has no title, or isn't fully loaded yet).
   * Shared by the full build and incremental updates.
   */
  private buildNoteInfo(item: Zotero.Item): NoteInfo | null {
    try {
      if (!item?.isNote()) return null;
      if (item.parentID) return null;
      const title = item.getField("title") || "";
      if (!title) return null;
      const dateAdded = new Date(item.dateAdded);
      return {
        id: item.id,
        title,
        lowerTitle: title.toLowerCase(),
        libraryID: item.libraryID,
        dateAdded,
        dateAddedMs: dateAdded.getTime(),
      };
    } catch {
      // Skip items that aren't fully loaded yet
      return null;
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
      const dateDiff = b.note.dateAddedMs - a.note.dateAddedMs;
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
    // Recompute lazily — incremental updates mark this dirty rather than
    // resorting on every notify.
    if (NoteSearchService.recentNotesDirty) {
      NoteSearchService.recentNotes = Array.from(
        NoteSearchService.cache.values(),
      ).sort((a, b) => b.dateAddedMs - a.dateAddedMs);
      NoteSearchService.recentNotesDirty = false;
    }
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
    NoteSearchService.recentNotesDirty = false;
  }
}
