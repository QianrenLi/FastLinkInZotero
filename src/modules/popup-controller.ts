// src/modules/popup-controller.ts
import { escapeHtml, escapeRegex } from "../utils/html";

export interface PopupItem {
  noteId: number;
  title: string;
  matchType: "exact" | "prefix" | "contains";
}

export interface PopupOptions {
  onSelection: (
    noteId: number | null,
    noteTitle: string,
    searchQuery: string,
  ) => void;
  onClose: () => void;
}

const ITEM_STYLE =
  "padding:7px 12px;cursor:pointer;color:#222;font-size:13px;border-bottom:1px solid #f0f0f0;";
const CREATE_STYLE =
  "padding:8px 12px;border-top:1px solid #ddd;cursor:pointer;color:#0066cc;background:#fff;font-size:13px;";
const CONTAINER_STYLE =
  "background:#fff;color:#222;border:1px solid #888;border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.25);max-width:350px;overflow:hidden;font-family:-moz-dialog;padding:0;margin:0;";

export class PopupController {
  private element: HTMLElement | null = null;
  private _innerContainer: HTMLElement | null = null;
  private items: PopupItem[] = [];
  private selectedIndex = 0;
  private currentQuery = "";
  private onSelection: (
    noteId: number | null,
    noteTitle: string,
    searchQuery: string,
  ) => void;
  private onClose: () => void;
  private clickHandler: ((e: Event) => void) | null = null;
  private _clickHandlerBound: ((e: Event) => void) | null = null;

  constructor(options: PopupOptions) {
    this.onSelection = options.onSelection;
    this.onClose = options.onClose;

    // Create click handler once, reuse across renders
    this._clickHandlerBound = (e: Event): void => {
      const target = e.target as HTMLElement;
      const itemElement = target.closest(
        ".fastlink-popup-item, .fastlink-popup-create-new",
      );
      if (!itemElement) return;

      if (itemElement.classList.contains("fastlink-popup-create-new")) {
        this.onSelection(null, this.currentQuery, this.currentQuery);
      } else {
        const index = parseInt(
          itemElement.getAttribute("data-index") || "0",
          10,
        );
        this.selectedIndex = index;
        this.selectCurrent();
      }
    };
  }

  show(x: number, y: number): void {
    if (!this.element) this.createPopup();

    if (this.element) {
      this.selectedIndex = 0;
      try {
        const mainWindow = Zotero.getMainWindow();
        if (mainWindow) {
          const clampedX = Math.min(
            Math.max(x, 10),
            mainWindow.innerWidth - 360,
          );
          (this.element as any).openPopup(
            mainWindow.document.documentElement,
            "overlap",
            clampedX,
            y,
            false,
            false,
          );
        }
      } catch (e) {
        Zotero.debug(`[FastLink] Popup openPopup error: ${e}`);
      }
    }
  }

  hide(): void {
    if (this.element) {
      try {
        (this.element as any).hidePopup();
      } catch {
        this.element.style.display = "none";
      }
    }
  }

  /**
   * Replace the result list and re-render in a single pass. This is the only
   * method that should run during typing — the caller (autocomplete) debounces
   * the search that feeds it, so each visible update is one render with the
   * correct query already applied.
   */
  setSearchResults(items: PopupItem[], query: string): void {
    this.currentQuery = query;
    this.items = items;
    this.selectedIndex = 0;
    this.render();
  }

  setItems(items: PopupItem[]): void {
    this.items = items;
    this.selectedIndex = 0;
    this.render();
  }

  /**
   * Update the tracked query cheaply without re-rendering. Kept so query-driven
   * logic (hasCreateOption, selectCurrent) stays in sync the instant a key is
   * pressed, before the debounced search/render catches up.
   */
  updateQuery(query: string): void {
    this.currentQuery = query;
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.element) return false;

    try {
      const state = (this.element as any).state;
      if (state !== "open" && state !== "showing") return false;
    } catch {
      if (this.element.style.display !== "block") return false;
    }

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const maxDown = this.hasCreateOption()
          ? this.items.length
          : this.items.length - 1;
        if (maxDown >= 0) {
          this.selectedIndex = Math.min(this.selectedIndex + 1, maxDown);
          this.updateSelectionHighlight();
        }
        return true;
      }

      case "ArrowUp":
        event.preventDefault();
        if (this.selectedIndex > 0) {
          this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
          this.updateSelectionHighlight();
        }
        return true;

      case "Enter":
        event.preventDefault();
        this.selectCurrent();
        return true;

      case "Escape":
        event.preventDefault();
        this.hide();
        this.onClose();
        return true;

      case "Tab":
        event.preventDefault();
        this.selectCurrent();
        return true;
    }

    return false;
  }

  isVisible(): boolean {
    if (!this.element) return false;
    try {
      const state = (this.element as any).state;
      return state === "open" || state === "showing";
    } catch {
      return this.element.style.display === "block";
    }
  }

  destroy(): void {
    if (this.element) {
      try {
        (this.element as any).hidePopup();
      } catch {
        // hidePopup may throw if panel is already detached
      }
      if (this._clickHandlerBound && this._innerContainer) {
        this._innerContainer.removeEventListener(
          "click",
          this._clickHandlerBound,
        );
      }
      this.element.remove();
      this.element = null;
    }
    this._innerContainer = null;
    this.clickHandler = null;
  }

  private createPopup(): void {
    const mainWindow = Zotero.getMainWindow();
    if (!mainWindow) throw new Error("Zotero main window not available");
    const doc = mainWindow.document;

    const panel = doc.createXULElement("panel") as HTMLElement;
    this.element = panel;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("flip", "both");
    panel.setAttribute("rolluponmousewheel", "true");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("style", "padding: 0; margin: 0;");

    const inner = doc.createElement("div");
    inner.className = "fastlink-popup-inner";
    inner.setAttribute("style", CONTAINER_STYLE);
    panel.appendChild(inner);
    this._innerContainer = inner;

    // Attach click handler once
    if (this._clickHandlerBound) {
      inner.addEventListener("click", this._clickHandlerBound);
    }

    doc.documentElement?.appendChild(panel);
  }

  private render(): void {
    const container = this._innerContainer;
    if (!container) return;

    let html =
      '<div style="padding:6px 10px;border-bottom:1px solid #ddd;font-weight:bold;color:#555;font-size:12px;background:#f7f7f7;">Search notes...</div>';
    html += '<div style="max-height:260px;overflow-y:auto;">';

    if (this.items.length === 0) {
      html +=
        '<div style="padding:12px;color:#999;text-align:center;">No matches found</div>';
      if (this.currentQuery.trim()) {
        html += this.renderCreateOption("#eee");
      }
    } else {
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i];
        const bg =
          i === this.selectedIndex
            ? "background-color:#e8f0fe;"
            : "background-color:#fff;";
        const matchHtml = this.highlightMatch(item.title, this.currentQuery);
        html += `<div class="fastlink-popup-item" data-index="${i}" style="${ITEM_STYLE}${bg}">${matchHtml}</div>`;
      }
      if (this.currentQuery.trim()) {
        html += this.renderCreateOption("#ddd");
      }
    }

    html += "</div>";
    container.innerHTML = html;
  }

  private renderCreateOption(borderColor: string): string {
    return `<div class="fastlink-popup-create-new" style="${CREATE_STYLE}border-top:1px solid ${borderColor};">+ Create "${escapeHtml(this.currentQuery)}"</div>`;
  }

  /**
   * Update only the selection highlight without full re-render (for arrow keys).
   */
  private updateSelectionHighlight(): void {
    const container = this._innerContainer;
    if (!container) return;

    const items = container.querySelectorAll(".fastlink-popup-item");
    const createEl = container.querySelector(".fastlink-popup-create-new");
    const createSelected =
      this.hasCreateOption() && this.selectedIndex === this.items.length;

    items.forEach((el: Element, i: number) => {
      (el as HTMLElement).style.backgroundColor =
        i === this.selectedIndex ? "#e8f0fe" : "#fff";
    });

    if (createEl) {
      (createEl as HTMLElement).style.backgroundColor = createSelected
        ? "#e8f0fe"
        : "#fff";
    }
  }

  private hasCreateOption(): boolean {
    return this.currentQuery.trim().length > 0;
  }

  private selectCurrent(): void {
    if (
      this.items.length === 0 ||
      (this.hasCreateOption() && this.selectedIndex === this.items.length)
    ) {
      this.onSelection(null, this.currentQuery, this.currentQuery);
    } else {
      if (this.selectedIndex < 0 || this.selectedIndex >= this.items.length) {
        this.selectedIndex = 0;
      }
      const item = this.items[this.selectedIndex];
      this.onSelection(item.noteId, item.title, this.currentQuery);
    }
    this.hide();
  }

  private highlightMatch(title: string, query: string): string {
    const escapedTitle = escapeHtml(title);
    if (!query.trim()) return escapedTitle;

    const escapedQuery = escapeHtml(query);
    const regex = new RegExp(`(${escapeRegex(escapedQuery)})`, "gi");
    return escapedTitle.replace(
      regex,
      '<span style="font-weight:bold;color:#1a73e8;">$1</span>',
    );
  }
}
