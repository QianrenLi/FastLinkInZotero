// src/modules/slash-popup-controller.ts
import { escapeHtml } from "../utils/html";
import type { SlashCommand } from "./slash-commands";

export interface SlashPopupOptions {
  /** Called with the highlighted command on Enter/Tab/click. Never null. */
  onSelection: (command: SlashCommand) => void;
  /** Called when the popup is dismissed without a selection (Escape). */
  onClose: () => void;
}

const ITEM_STYLE =
  "padding:6px 12px;cursor:pointer;color:#222;font-size:13px;border-bottom:1px solid #f0f0f0;display:flex;gap:10px;align-items:baseline;";
const TRIGGER_STYLE = "color:#1a73e8;font-weight:600;min-width:56px;";
const DESC_STYLE = "color:#666;";
const CONTAINER_STYLE =
  "background:#fff;color:#222;border:1px solid #888;border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.25);min-width:240px;max-width:360px;overflow:hidden;font-family:-moz-dialog;padding:0;margin:0;";

export class SlashPopupController {
  private element: HTMLElement | null = null;
  private _innerContainer: HTMLElement | null = null;
  private _hostWindow: Window | null = null;
  private items: SlashCommand[] = [];
  private selectedIndex = 0;
  private onSelection: (command: SlashCommand) => void;
  private onClose: () => void;
  private _clickHandlerBound: ((e: Event) => void) | null = null;

  constructor(options: SlashPopupOptions) {
    this.onSelection = options.onSelection;
    this.onClose = options.onClose;
    this._clickHandlerBound = (e: Event): void => {
      const itemEl = (e.target as HTMLElement).closest(
        ".fastlink-slash-item",
      ) as HTMLElement | null;
      if (!itemEl) return;
      const index = parseInt(itemEl.getAttribute("data-index") || "0", 10);
      this.selectedIndex = index;
      this.selectCurrent();
    };
  }

  show(x: number, y: number, hostWin: Window = Zotero.getMainWindow()): void {
    if (!this.element || this._hostWindow !== hostWin) {
      this.destroy();
      this.createPopup(hostWin);
    }
    if (this.element) {
      this.selectedIndex = 0;
      try {
        if (hostWin) {
          const clampedX = Math.min(Math.max(x, 10), hostWin.innerWidth - 380);
          (this.element as any).openPopup(
            hostWin.document.documentElement,
            "overlap",
            clampedX,
            y,
            false,
            false,
          );
        }
      } catch (e) {
        Zotero.debug(`[FastLink] slash popup openPopup error: ${e}`);
      }
    }
  }

  /** Replace the candidate list and re-render. */
  setCommands(items: SlashCommand[]): void {
    this.items = items;
    this.selectedIndex = 0;
    this.render();
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
      case "ArrowDown":
        event.preventDefault();
        if (this.items.length > 0) {
          this.selectedIndex = Math.min(
            this.selectedIndex + 1,
            this.items.length - 1,
          );
          this.updateSelectionHighlight();
        }
        return true;
      case "ArrowUp":
        event.preventDefault();
        if (this.selectedIndex > 0) {
          this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
          this.updateSelectionHighlight();
        }
        return true;
      case "Enter":
      case "Tab":
        event.preventDefault();
        this.selectCurrent();
        return true;
      case "Escape":
        event.preventDefault();
        this.hide();
        this.onClose();
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

  hide(): void {
    if (this.element) {
      try {
        (this.element as any).hidePopup();
      } catch {
        this.element.style.display = "none";
      }
    }
  }

  destroy(): void {
    if (this.element) {
      try {
        (this.element as any).hidePopup();
      } catch {
        /* already detached */
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
    this._hostWindow = null;
  }

  private createPopup(hostWin: Window): void {
    if (!hostWin) throw new Error("Zotero host window not available");
    const doc = hostWin.document;
    const panel = doc.createXULElement("panel") as HTMLElement;
    this.element = panel;
    this._hostWindow = hostWin;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("flip", "both");
    panel.setAttribute("rolluponmousewheel", "true");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("style", "padding: 0; margin: 0;");

    const inner = doc.createElement("div");
    inner.className = "fastlink-slash-inner";
    inner.setAttribute("style", CONTAINER_STYLE);
    panel.appendChild(inner);
    this._innerContainer = inner;
    if (this._clickHandlerBound) {
      inner.addEventListener("click", this._clickHandlerBound);
    }
    doc.documentElement?.appendChild(panel);
  }

  private render(): void {
    const container = this._innerContainer;
    if (!container) return;

    let html =
      '<div style="padding:6px 10px;border-bottom:1px solid #ddd;font-weight:bold;color:#555;font-size:12px;background:#f7f7f7;">Commands</div>';
    html += '<div style="max-height:260px;overflow-y:auto;">';

    if (this.items.length === 0) {
      html +=
        '<div style="padding:12px;color:#999;text-align:center;">No matching command</div>';
    } else {
      for (let i = 0; i < this.items.length; i++) {
        const cmd = this.items[i];
        const bg =
          i === this.selectedIndex
            ? "background-color:#e8f0fe;"
            : "background-color:#fff;";
        html +=
          `<div class="fastlink-slash-item" data-index="${i}" style="${ITEM_STYLE}${bg}">` +
          `<span style="${TRIGGER_STYLE}">/${escapeHtml(cmd.trigger)}</span>` +
          `<span style="${DESC_STYLE}">${escapeHtml(cmd.description)}</span>` +
          `</div>`;
      }
    }

    html += "</div>";
    container.innerHTML = html;
  }

  private updateSelectionHighlight(): void {
    const container = this._innerContainer;
    if (!container) return;
    const items = container.querySelectorAll(".fastlink-slash-item");
    items.forEach((el: Element, i: number) => {
      (el as HTMLElement).style.backgroundColor =
        i === this.selectedIndex ? "#e8f0fe" : "#fff";
    });
  }

  private selectCurrent(): void {
    if (this.items.length === 0) return;
    if (this.selectedIndex < 0 || this.selectedIndex >= this.items.length) {
      this.selectedIndex = 0;
    }
    const cmd = this.items[this.selectedIndex];
    this.hide();
    this.onSelection(cmd);
  }
}
