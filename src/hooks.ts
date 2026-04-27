// src/hooks.ts
import { NoteLinkAutocomplete } from "./modules/note-link-autocomplete";
import { QuickCreateHandler } from "./modules/quick-create-handler";
import { NoteSearchService } from "./modules/note-search-service";
import { LinkInserter } from "./modules/link-inserter";
import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import {
  setupFileLogging,
  teardownFileLogging,
  getLogCount,
  flushLogToFile,
  getLogContent,
} from "./utils/file-logger";

let autocomplete: NoteLinkAutocomplete | null = null;
let quickCreate: QuickCreateHandler | null = null;

// Shared instances — both components use the same service/inserter
const sharedSearchService = new NoteSearchService();
const sharedLinkInserter = new LinkInserter();

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  await setupFileLogging();

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

    quickCreate = new QuickCreateHandler(
      sharedSearchService,
      sharedLinkInserter,
    );
    await quickCreate.initialize();

    // Register Ctrl+N shortcut
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

      Zotero.debug("[FastLink] Keyboard shortcut registered");
    } catch (error) {
      Zotero.debug(`[FastLink] Failed to register keyboard shortcut: ${error}`);
    }

    registerDebugMenu();
    Zotero.debug("[FastLink] All components initialized");
  } catch (e) {
    Zotero.debug(`[FastLink] Error during initialization: ${e}`);
  }

  addon.data.initialized = true;

  (addon.data as any).getLogCount = getLogCount;
  (addon.data as any).getLogContent = getLogContent;
  (addon.data as any).flushLogToFile = flushLogToFile;
}

function onMainWindowLoad(win: _ZoteroTypes.MainWindow): void {
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
}

function onMainWindowUnload(win: Window): void {
  addon.data.ztoolkit.unregisterAll();
}

function onShutdown(): void {
  teardownFileLogging();
  autocomplete?.destroy();
  quickCreate?.destroy();
  quickCreate = null;
  autocomplete = null;

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

function registerDebugMenu() {
  try {
    addon.data.ztoolkit.Menu.register("menuTools", {
      tag: "menuseparator",
    });

    addon.data.ztoolkit.Menu.register("menuTools", {
      tag: "menuitem",
      id: "fastlink-test",
      label: "Test FastLink",
      oncommand: `
        (function() {
          const mainWindow = Zotero.getMainWindow();
          mainWindow.alert(
            '[FastLink] Plugin Status:\\n' +
            'Initialized: ${addon.data.initialized}\\n' +
            'If you see this, FastLink is loaded!'
          );
        })();
      `,
    });

    addon.data.ztoolkit.Menu.register("menuTools", {
      tag: "menuitem",
      id: "fastlink-save-log",
      label: "FastLink: Save Debug Log",
      oncommand: `
        (async function() {
          const mainWindow = Zotero.getMainWindow();
          const data = Zotero.FastLink.data;
          const count = data.getLogCount();
          if (count === 0) {
            mainWindow.alert('[FastLink] No log messages captured yet.');
            return;
          }
          const ok = await data.flushLogToFile();
          if (ok) {
            mainWindow.alert('[FastLink] Saved ' + count + ' log lines to file.');
          } else {
            const content = data.getLogContent();
            mainWindow.alert('[FastLink] File write failed. Log:\\n\\n' + content.substring(0, 3000));
          }
        })();
      `,
    });

    addon.data.ztoolkit.Menu.register("menuTools", {
      tag: "menuitem",
      id: "fastlink-view-log",
      label: "FastLink: View Debug Log",
      oncommand: `
        (function() {
          const mainWindow = Zotero.getMainWindow();
          const data = Zotero.FastLink.data;
          const content = data.getLogContent();
          if (!content) {
            mainWindow.alert('[FastLink] No log messages captured.');
            return;
          }
          mainWindow.alert('[FastLink] Debug Log (' + content.split('\\n').length + ' lines):\\n\\n' + content.substring(0, 3000));
        })();
      `,
    });
  } catch (error) {
    Zotero.debug(`[FastLink] Failed to register debug menu: ${error}`);
  }
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
