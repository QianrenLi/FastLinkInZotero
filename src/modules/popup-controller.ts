// src/modules/popup-controller.ts
import { debounce } from '../utils/debounce';

export interface PopupItem {
  noteId: number;
  title: string;
  matchType: 'exact' | 'prefix' | 'contains';
}

export interface PopupOptions {
  onSelection: (noteId: number | null, query: string) => void;
  onClose: () => void;
}

export class PopupController {
  private element: HTMLElement | null = null;
  private items: PopupItem[] = [];
  private selectedIndex = 0;
  private currentQuery = '';
  private onSelection: (noteId: number | null, query: string) => void;
  private onClose: () => void;
  private debouncedFilter: (query: string) => void;
  private clickHandler: ((e: Event) => void) | null = null;

  constructor(options: PopupOptions) {
    this.onSelection = options.onSelection;
    this.onClose = options.onClose;
    this.debouncedFilter = debounce((query: string) => {
      this.refreshDisplay(query);
    }, 150);
  }

  /**
   * Show popup at cursor position
   */
  show(x: number, y: number): void {
    if (!this.element) {
      this.createPopup();
    }

    if (this.element) {
      this.element.style.left = `${x}px`;
      this.element.style.top = `${y}px`;
      this.element.style.display = 'block';
      this.selectedIndex = 0;
    }
  }

  /**
   * Hide popup
   */
  hide(): void {
    if (this.element) {
      this.element.style.display = 'none';
    }
  }

  /**
   * Update popup items
   */
  setItems(items: PopupItem[]): void {
    this.items = items;
    this.selectedIndex = 0;
    this.render();
  }

  /**
   * Update query and filter items
   */
  updateQuery(query: string): void {
    this.currentQuery = query;
    this.debouncedFilter(query);
  }

  /**
   * Handle keyboard navigation
   */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.element || this.element.style.display === 'none') {
      return false;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (this.items.length > 0) {
          this.selectedIndex = Math.min(this.selectedIndex + 1, this.items.length - 1);
          this.render();
        }
        return true;

      case 'ArrowUp':
        event.preventDefault();
        if (this.items.length > 0) {
          this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
          this.render();
        }
        return true;

      case 'Enter':
        event.preventDefault();
        this.selectCurrent();
        return true;

      case 'Escape':
        event.preventDefault();
        this.hide();
        this.onClose();
        return true;

      case 'Tab':
        event.preventDefault();
        this.selectCurrent();
        return true;
    }

    return false;
  }

  /**
   * Check if popup is visible
   */
  isVisible(): boolean {
    return this.element?.style.display === 'block';
  }

  /**
   * Clean up popup
   */
  destroy(): void {
    if (this.element) {
      // Remove click handler before cleaning up element
      const itemsContainer = this.element.querySelector('.fastlink-popup-content');
      if (itemsContainer && this.clickHandler) {
        itemsContainer.removeEventListener('click', this.clickHandler);
      }
      this.element.remove();
      this.element = null;
    }
    this.clickHandler = null;
  }

  /**
   * Create popup DOM element
   */
  private createPopup(): void {
    const mainWindow = Zotero.getMainWindow();
    if (!mainWindow) {
      throw new Error('Zotero main window not available');
    }
    const doc = mainWindow.document;
    this.element = doc.createElement('div');
    this.element.className = 'fastlink-popup';
    if (doc.body) {
      doc.body.appendChild(this.element);
    }

    // Load external CSS
    if (!doc.getElementById('fastlink-popup-styles')) {
      const link = doc.createElement('link');
      link.id = 'fastlink-popup-styles';
      link.rel = 'stylesheet';
      link.href = 'chrome://fastlink/content/modules/popup.css';
      if (doc.head) {
        doc.head.appendChild(link);
      }
    }
  }

  /**
   * Refresh display based on query
   */
  private refreshDisplay(query: string): void {
    if (!this.element) return;

    const container = this.element.querySelector('.fastlink-popup-content');
    if (!container) return;

    if (!query.trim()) {
      // Show recent notes when query is empty
      this.render();
      return;
    }

    this.render();
  }

  /**
   * Render popup content
   */
  private render(): void {
    if (!this.element) return;

    let html = '<div class="fastlink-popup-header">🔍 Search notes...</div>';
    html += '<div class="fastlink-popup-content">';

    if (this.items.length === 0) {
      html += `<div class="fastlink-popup-empty">No matches found</div>`;
      html += `<div class="fastlink-popup-create-new">+ Create "${this.escapeHtml(this.currentQuery)}"</div>`;
    } else {
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i];
        const selected = i === this.selectedIndex ? 'selected' : '';
        const matchHtml = this.highlightMatch(item.title, this.currentQuery);

        html += `
          <div class="fastlink-popup-item ${selected}" data-index="${i}">
            <span class="fastlink-popup-item-icon">📄</span>
            <span class="fastlink-popup-item-title">${matchHtml}</span>
          </div>
        `;
      }
    }

    html += '</div>';

    this.element.innerHTML = html;

    // Add click listeners
    const itemsContainer = this.element.querySelector('.fastlink-popup-content');
    if (itemsContainer) {
      // Remove old listener if exists
      if (this.clickHandler) {
        itemsContainer.removeEventListener('click', this.clickHandler);
      }

      // Create and store new handler
      this.clickHandler = (e: Event): void => {
        const target = e.target as HTMLElement;
        const itemElement = target.closest('.fastlink-popup-item, .fastlink-popup-create-new');
        if (itemElement) {
          if (itemElement.classList.contains('fastlink-popup-create-new')) {
            this.onSelection(null, this.currentQuery);
          } else {
            const index = parseInt(itemElement.getAttribute('data-index') || '0', 10);
            this.selectedIndex = index;
            this.selectCurrent();
          }
        }
      };

      itemsContainer.addEventListener('click', this.clickHandler);
    }
  }

  /**
   * Select current item
   */
  private selectCurrent(): void {
    if (this.items.length === 0) {
      this.onSelection(null, this.currentQuery);
    } else {
      // Ensure selectedIndex is within bounds
      if (this.selectedIndex < 0 || this.selectedIndex >= this.items.length) {
        this.selectedIndex = 0;
      }
      const item = this.items[this.selectedIndex];
      this.onSelection(item.noteId, item.title);
    }
    this.hide();
  }

  /**
   * Highlight matched text in title
   */
  private highlightMatch(title: string, query: string): string {
    if (!query.trim()) return this.escapeHtml(title);

    const escapedTitle = this.escapeHtml(title);
    const escapedQuery = this.escapeHtml(query);
    const regex = new RegExp(`(${this.escapeRegex(escapedQuery)})`, 'gi');

    return escapedTitle.replace(regex, '<span class="fastlink-popup-item-match">$1</span>');
  }

  /**
   * Escape HTML
   */
  private escapeHtml(text: string): string {
    const mainWindow = Zotero.getMainWindow();
    if (!mainWindow || !mainWindow.document) {
      throw new Error('Zotero main window not available');
    }
    const doc = mainWindow.document;
    const div = doc.createElement('div');
    div.textContent = text;
    return String(div.innerHTML);
  }

  /**
   * Escape regex special characters
   */
  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
