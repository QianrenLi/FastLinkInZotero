// src/hooks.ts
import { NoteLinkAutocomplete } from './modules/note-link-autocomplete';
import { QuickCreateHandler } from './modules/quick-create-handler';
import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";

let autocomplete: NoteLinkAutocomplete | null = null;
let quickCreate: QuickCreateHandler | null = null;

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

  // Initialize FastLink components
  try {
    autocomplete = new NoteLinkAutocomplete();
    await autocomplete.initialize();

    quickCreate = new QuickCreateHandler();
    await quickCreate.initialize();

    // Register shortcuts after quickCreate is initialized
    try {
      addon.data.ztoolkit.Keyboard.register((ev, keyOptions) => {
        if (keyOptions.keyboard?.equals('accel,n')) {
          Zotero.debug('[FastLink] Ctrl+N shortcut triggered');
          if (quickCreate) {
            void quickCreate.handleQuickCreate();
          }
        }
      });
      Zotero.debug('[FastLink] Keyboard shortcut registered successfully');
    } catch (error) {
      Zotero.debug(`[FastLink] Failed to register keyboard shortcut: ${error}`);
    }

    Zotero.debug('[FastLink] All components initialized');
  } catch (e) {
    Zotero.debug(`[FastLink] Error during initialization: ${e}`);
  }

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
}

async function onMainWindowUnload(win: Window): Promise<void> {
  addon.data.ztoolkit.unregisterAll();
}

function onShutdown(): void {
  // Clean up FastLink components
  autocomplete?.destroy();
  quickCreate?.destroy();
  quickCreate = null;
  autocomplete = null;

  addon.data.ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

function onShortcuts(type: string) {
  if (type === 'quickCreate' && quickCreate) {
    void quickCreate.handleQuickCreate();
  }
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  // Notifier is handled by NoteLinkAutocomplete
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
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
  onShortcuts,
  onDialogEvents,
};
