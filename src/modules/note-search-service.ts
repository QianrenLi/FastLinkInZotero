export interface NoteInfo {
  id: number;
  title: string;
  libraryID: number;
  dateAdded: Date;
}

export interface SearchResult {
  note: NoteInfo;
  matchType: 'exact' | 'prefix' | 'contains';
}

export class NoteSearchService {
  private cache: Map<number, NoteInfo> = new Map();
  private cacheBuilt = false;

  /**
   * Build cache of all independent notes (notes without parentID)
   */
  async buildCache(): Promise<void> {
    try {
      const s = new Zotero.Search();
      s.addCondition('itemType', 'is', 'note');
      const ids = await s.search();

      this.cache.clear();
      for (const id of ids) {
        const item = Zotero.Items.get(id);
        if (!item?.isNote()) continue;
        if (item.parentID) continue; // Skip child notes

        const title = item.getField('title') || '';
        if (!title) continue; // Skip notes without titles

        this.cache.set(id, {
          id: item.id,
          title: title,
          libraryID: item.libraryID,
          dateAdded: new Date(item.dateAdded),
        });
      }

      this.cacheBuilt = true;
      Zotero.debug(`[FastLink] Built cache with ${this.cache.size} notes`);
    } catch (e) {
      Zotero.debug(`[FastLink] Error building cache: ${e}`);
    }
  }

  /**
   * Search notes by query with ranking
   */
  search(query: string): SearchResult[] {
    if (!this.cacheBuilt) {
      Zotero.debug('[FastLink] Cache not built, returning empty');
      return [];
    }

    const searchTerm = query.trim().toLowerCase();
    if (!searchTerm) {
      // Return recent notes if no query
      return this.getRecentNotes(10);
    }

    const results: SearchResult[] = [];

    for (const note of this.cache.values()) {
      const lowerTitle = note.title.toLowerCase();

      if (lowerTitle === searchTerm) {
        results.push({ note, matchType: 'exact' });
      } else if (lowerTitle.startsWith(searchTerm)) {
        results.push({ note, matchType: 'prefix' });
      } else if (lowerTitle.includes(searchTerm)) {
        results.push({ note, matchType: 'contains' });
      }
    }

    // Sort by match type, then recency, then title length
    return this.rankResults(results);
  }

  /**
   * Get recent notes (used when query is empty)
   */
  private getRecentNotes(limit: number): SearchResult[] {
    const notes = Array.from(this.cache.values())
      .sort((a, b) => b.dateAdded.getTime() - a.dateAdded.getTime())
      .slice(0, limit);

    return notes.map(note => ({ note, matchType: 'exact' as const }));
  }

  /**
   * Rank results by relevance
   */
  private rankResults(results: SearchResult[]): SearchResult[] {
    const matchTypeOrder = { exact: 0, prefix: 1, contains: 2 };

    return results.sort((a, b) => {
      // First by match type
      const typeDiff = matchTypeOrder[a.matchType] - matchTypeOrder[b.matchType];
      if (typeDiff !== 0) return typeDiff;

      // Then by recency (newer first)
      const dateDiff = b.note.dateAdded.getTime() - a.note.dateAdded.getTime();
      if (dateDiff !== 0) return dateDiff;

      // Then by title length (shorter first for brevity)
      return a.note.title.length - b.note.title.length;
    });
  }

  /**
   * Get note by ID
   */
  getNote(id: number): NoteInfo | undefined {
    return this.cache.get(id);
  }

  /**
   * Check if cache needs rebuild
   */
  isCacheBuilt(): boolean {
    return this.cacheBuilt;
  }

  /**
   * Clear cache (call when notes are modified)
   */
  clearCache(): void {
    this.cacheBuilt = false;
    this.cache.clear();
  }
}
