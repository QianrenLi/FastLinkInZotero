// src/modules/slash-command-handler.ts
import { LinkInserter } from "./link-inserter";
import {
  SLASH_COMMANDS,
  SlashCommand,
  filterByPrefix,
  isContinuousWord,
  shouldTriggerSlash,
} from "./slash-commands";
import { SlashPopupController } from "./slash-popup-controller";
import {
  getAllWindows,
  getEditorWindow,
  setCachedEditorWindow,
} from "../utils/editor-detector";
import {
  captureCursorPosition,
  getTextBeforeCaret,
} from "../utils/editor-caret";
import { escapeHtml } from "../utils/html";

export class SlashCommandHandler {
  private linkInserter: LinkInserter;
  private popup: SlashPopupController | null = null;
  private isActive = false;
  private _lastEditorWindow: Window | null = null;

  private _keyDownHandler:
    | ((this: Document, ev: DocumentEventMap["keydown"]) => void)
    | null = null;
  private _inputHandler:
    | ((this: Document, ev: DocumentEventMap["input"]) => void)
    | null = null;

  private _windowState = new Map<
    Window,
    {
      iframeDocuments: Set<Document>;
      iframeLoadHandlers: Map<HTMLIFrameElement, (event: Event) => void>;
      observer: MutationObserver;
      iframeTimer: ReturnType<typeof setTimeout> | null;
    }
  >();

  private _windowWatcherListener:
    | ((subject: any, topic: string, data: any) => void)
    | null = null;

  private static readonly POPUP_Y_OFFSET = 20;
  private static readonly QUERY_BACK_BUDGET = 512;

  constructor(linkInserter: LinkInserter) {
    this.linkInserter = linkInserter;
  }

  initialize(): void {
    this._keyDownHandler = this.handleKeyDown.bind(this);
    this._inputHandler = this.handleInput.bind(this);
    for (const win of getAllWindows()) {
      this.attachToWindow(win);
    }
    this.registerWindowWatcher();
    Zotero.debug("[FastLink] SlashCommandHandler initialized");
  }

  /**
   * Register a window-watcher so we attach to new chrome windows of any type —
   * critically, note windows (note.xhtml), which onMainWindowLoad does NOT fire
   * for. Mirrors NoteLinkAutocomplete.registerWindowWatcher.
   */
  private registerWindowWatcher(): void {
    try {
      const ww = Services?.ww;
      if (!ww?.registerNotification) {
        Zotero.debug("[FastLink] slash: Services.ww unavailable");
        return;
      }
      this._windowWatcherListener = (subject: any, topic: string): void => {
        try {
          if (topic === "domwindowopened") {
            const win = subject as Window;
            const attach = (): void => {
              if (win?.document) this.attachToWindow(win);
            };
            if (win?.document?.readyState === "complete") attach();
            else win?.addEventListener?.("load", attach, { once: true });
          } else if (topic === "domwindowclosed") {
            if (this._windowState.has(subject as Window)) {
              this.detachFromWindow(subject as Window);
            }
          }
        } catch (e) {
          Zotero.debug(`[FastLink] slash window watcher event error: ${e}`);
        }
      };
      ww.registerNotification(this._windowWatcherListener);
    } catch (e) {
      Zotero.debug(`[FastLink] slash registerWindowWatcher failed: ${e}`);
    }
  }

  attachToWindow(win: Window): void {
    if (!win || this._windowState.has(win)) return;
    if (!this._keyDownHandler || !this._inputHandler) return;

    const doc = win.document;
    doc.addEventListener("keydown", this._keyDownHandler, true);
    doc.addEventListener("input", this._inputHandler, true);

    const state = {
      iframeDocuments: new Set<Document>(),
      iframeLoadHandlers: new Map<HTMLIFrameElement, (event: Event) => void>(),
      observer: undefined as unknown as MutationObserver,
      iframeTimer: null as ReturnType<typeof setTimeout> | null,
    };
    this._windowState.set(win, state);

    const observer = new win.MutationObserver(() => {
      if (state.iframeTimer) return;
      state.iframeTimer = setTimeout(() => {
        state.iframeTimer = null;
        this.attachToEditorIframes(win);
      }, 100);
    });
    observer.observe(doc, { childList: true, subtree: true });
    state.observer = observer;

    this.attachToEditorIframes(win);
  }

  detachFromWindow(win: Window): void {
    const state = this._windowState.get(win);
    if (!state) return;
    const doc = (win as Window).document;
    if (this._keyDownHandler)
      doc.removeEventListener("keydown", this._keyDownHandler, true);
    if (this._inputHandler)
      doc.removeEventListener("input", this._inputHandler, true);
    for (const iframeDoc of state.iframeDocuments) {
      if (this._keyDownHandler)
        iframeDoc.removeEventListener("keydown", this._keyDownHandler, true);
      if (this._inputHandler)
        iframeDoc.removeEventListener("input", this._inputHandler, true);
    }
    state.iframeDocuments.clear();
    for (const [iframeEl, loadHandler] of state.iframeLoadHandlers.entries()) {
      iframeEl.removeEventListener("load", loadHandler);
    }
    state.iframeLoadHandlers.clear();
    if (state.iframeTimer) clearTimeout(state.iframeTimer);
    state.observer?.disconnect();
    this._windowState.delete(win);
  }

  getAttachedWindows(): Window[] {
    return Array.from(this._windowState.keys());
  }

  private attachToEditorIframes(win: Window): void {
    if (!this._keyDownHandler || !this._inputHandler) return;
    const state = this._windowState.get(win);
    if (!state) return;
    const iframes = win.document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const iframeEl = iframe as HTMLIFrameElement;
        if (state.iframeLoadHandlers.has(iframeEl)) continue;
        this.tryAttachToIframeDoc(state, iframeEl);
        const loadHandler = (): void => {
          this.tryAttachToIframeDoc(state, iframeEl);
        };
        iframeEl.addEventListener("load", loadHandler);
        state.iframeLoadHandlers.set(iframeEl, loadHandler);
      } catch {
        /* skip */
      }
    }
  }

  private tryAttachToIframeDoc(
    state: { iframeDocuments: Set<Document> },
    iframeEl: HTMLIFrameElement,
  ): void {
    try {
      const iframeDoc = iframeEl.contentDocument;
      if (!iframeDoc || (iframeDoc as any)._fastLinkSlashAttached) return;
      (iframeDoc as any)._fastLinkSlashAttached = true;
      iframeDoc.addEventListener("keydown", this._keyDownHandler!, true);
      iframeDoc.addEventListener("input", this._inputHandler!, true);
      state.iframeDocuments.add(iframeDoc);
    } catch {
      /* cross-origin */
    }
  }

  private handleKeyDown(event: Event): void {
    try {
      const keyEvent = event as KeyboardEvent;
      const target = event.target as HTMLElement;
      if (!target?.isContentEditable) return;

      const doc = target.ownerDocument;
      if (doc?.defaultView) {
        this._lastEditorWindow = doc.defaultView;
        setCachedEditorWindow(doc.defaultView);
      }

      if (this.popup?.isVisible()) {
        if (this.popup.handleKeyDown(keyEvent)) {
          event.stopPropagation();
          event.preventDefault();
          return;
        }
      }

      if (keyEvent.key === "Escape" && this.isActive) {
        this.closePopup();
        event.preventDefault();
      }
    } catch (e) {
      Zotero.debug(`[FastLink] slash handleKeyDown error: ${e}`);
    }
  }

  private handleInput(event: Event): void {
    const target = event.target as HTMLElement;
    if (!target?.isContentEditable) return;

    const doc = target.ownerDocument;
    if (doc?.defaultView) {
      this._lastEditorWindow = doc.defaultView;
      setCachedEditorWindow(doc.defaultView);
    }

    if (this.isActive && this.popup?.isVisible()) {
      // Keep the saved selection fresh so commit targets the right caret.
      this.linkInserter.saveSelection(doc?.defaultView || null);
      const token = this.getSlashToken();
      if (token === null) {
        // Word broken (space/punctuation) or "/" no longer at a trigger spot:
        // abort, leave the text as-is.
        this.closePopup();
        return;
      }
      const word = token.slice(1); // strip leading "/"
      const matches = filterByPrefix(SLASH_COMMANDS, word);
      if (matches.length === 0) {
        // No candidate matches the typed prefix: auto-dismiss, keep text.
        this.closePopup();
        return;
      }
      this.popup.setCommands(matches);
      return;
    }

    // Trigger detection: only inspect on inputs that actually inserted a "/".
    const data = (event as InputEvent).data;
    if (!data || !data.includes("/")) return;

    const textBeforeCaret = getTextBeforeCaret(
      this._lastEditorWindow || getEditorWindow(),
      SlashCommandHandler.QUERY_BACK_BUDGET,
    );
    if (
      textBeforeCaret &&
      shouldTriggerSlash(textBeforeCaret) &&
      !this.isActive
    ) {
      this.triggerSlash();
    }
  }

  private triggerSlash(): void {
    this.isActive = true;
    this.linkInserter.saveSelection(this._lastEditorWindow);

    if (!this.popup) {
      this.popup = new SlashPopupController({
        onSelection: (cmd) => {
          void this.commitCommand(cmd);
        },
        onClose: () => {
          this.handleClose();
        },
      });
    }

    const pos = captureCursorPosition(
      this._lastEditorWindow || getEditorWindow(),
    );
    if (!pos) {
      Zotero.debug("[FastLink] slash: no cursor position, not showing popup");
      this.isActive = false;
      return;
    }
    this.popup.show(
      pos.x,
      pos.y + SlashCommandHandler.POPUP_Y_OFFSET,
      pos.hostWindow,
    );
    this.popup.setCommands(filterByPrefix(SLASH_COMMANDS, ""));
  }

  private async commitCommand(cmd: SlashCommand): Promise<void> {
    const token = this.getSlashToken();
    this.popup?.hide();
    this.isActive = false;
    if (!token) return;

    const replacementHtml =
      cmd.output.kind === "html"
        ? cmd.output.value
        : escapeHtml(cmd.output.value);

    Zotero.debug(`[FastLink] slash commit "${token}" -> ${cmd.trigger}`);
    let ok = await this.linkInserter.insertHtmlAtTrigger(
      token,
      replacementHtml,
    );
    if (!ok) {
      Zotero.debug("[FastLink] slash editor insert failed; DB fallback");
      ok = await this.linkInserter.insertReplacementViaDb(
        token,
        replacementHtml,
      );
    }
    if (!ok) {
      Zotero.debug(`[FastLink] slash commit failed for "${token}"`);
    }
  }

  private handleClose(): void {
    this.isActive = false;
  }

  private closePopup(): void {
    this.popup?.hide();
    this.isActive = false;
  }

  /**
   * The literal `/word` token ending at the caret, or null when:
   *  - there is no "/" since the last whitespace, or
   *  - the text after the "/" is not a continuous word (space/punctuation), or
   *  - the "/" is not at a valid trigger position (not preceded by whitespace).
   */
  private getSlashToken(): string | null {
    const text = getTextBeforeCaret(
      this._lastEditorWindow || getEditorWindow(),
      SlashCommandHandler.QUERY_BACK_BUDGET,
    );
    if (text === null) return null;
    const idx = text.lastIndexOf("/");
    if (idx < 0) return null;
    const beforeSlash = text.slice(0, idx);
    if (beforeSlash.length > 0 && !/\s$/.test(beforeSlash)) return null;
    const token = text.slice(idx);
    if (token.length === 1) return token; // just "/"
    if (!isContinuousWord(token.slice(1))) return null;
    return token;
  }

  destroy(): void {
    try {
      if (this._windowWatcherListener) {
        Services?.ww?.unregisterNotification?.(this._windowWatcherListener);
        this._windowWatcherListener = null;
      }
    } catch {
      /* ignore */
    }
    for (const win of Array.from(this._windowState.keys())) {
      this.detachFromWindow(win);
    }
    this._windowState.clear();
    this._keyDownHandler = null;
    this._inputHandler = null;
    this.popup?.destroy();
  }
}
