import { NoteLinkAutocomplete } from "./modules/note-link-autocomplete";
import { QuickCreateHandler } from "./modules/quick-create-handler";
import { NoteSearchService } from "./modules/note-search-service";
import { LinkInserter } from "./modules/link-inserter";
import { initLocale } from "./utils/locale";

let autocomplete: NoteLinkAutocomplete | null = null;
let quickCreate: QuickCreateHandler | null = null;

const sharedSearchService = new NoteSearchService();
const sharedLinkInserter = new LinkInserter();

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  try {
    autocomplete = new NoteLinkAutocomplete(
      sharedSearchService,
      sharedLinkInserter,
    );
    await autocomplete.initialize();
    // Expose for tests / interactive debugging (which windows have `[[`
    // listeners attached).
    (addon as any).autocomplete = autocomplete;

    quickCreate = new QuickCreateHandler(
      sharedSearchService,
      sharedLinkInserter,
    );
    await quickCreate.initialize();

    try {
      addon.data.ztoolkit.Keyboard.register((ev, _keyOptions) => {
        try {
          if (ev.type !== "keydown") return false;

          const accelKey = ev.ctrlKey || ev.metaKey;
          if (!accelKey || ev.key.toLowerCase() !== "n") return false;

          const target = ev.target as HTMLElement;
          if (!target?.isContentEditable) return false;

          if (quickCreate) {
            void quickCreate.handleQuickCreate();
            ev.preventDefault();
            ev.stopPropagation();
            return true;
          }
          return false;
        } catch (error) {
          Zotero.debug(`[FastLink] Error in keyboard callback: ${error}`);
          return false;
        }
      });
    } catch (error) {
      Zotero.debug(`[FastLink] Failed to register keyboard shortcut: ${error}`);
    }
  } catch (e) {
    Zotero.debug(`[FastLink] Error during initialization: ${e}`);
  }

  addon.data.initialized = true;
}

function onMainWindowLoad(win: _ZoteroTypes.MainWindow): void {
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
  // Attach autocomplete listeners to this window so `[[` works in notes opened
  // in their own window too. attachToWindow is idempotent and a no-op before
  // initialize() has bound the handlers (e.g. during the startup window loop).
  autocomplete?.attachToWindow(win);
}

function onMainWindowUnload(win: Window): void {
  autocomplete?.detachFromWindow(win);
  addon.data.ztoolkit.unregisterAll();
}

function onShutdown(): void {
  autocomplete?.destroy();
  quickCreate?.destroy();
  quickCreate = null;
  autocomplete = null;
  (addon as any).autocomplete = undefined;

  addon.data.ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // Notifier is handled by NoteLinkAutocomplete
}

function onPrefsEvent(type: string, data: { [key: string]: any }) {
  // No prefs to handle
}

function onDialogEvents(type: string) {
  // No dialog events
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onDialogEvents,
};
