// src/utils/editor-detector.ts

let _cachedEditorWindow: Window | null = null;

export function setCachedEditorWindow(win: Window | null): void {
  _cachedEditorWindow = win;
}

function getIframeWindowFromHost(editorHost: any): Window | null {
  if (editorHost?._iframeWindow) return editorHost._iframeWindow;
  if (editorHost?._iframeElement?.contentWindow)
    return editorHost._iframeElement.contentWindow;
  return null;
}

/**
 * Resolve the editor host object from current Zotero tab state.
 */
function getEditorHost(win: _ZoteroTypes.MainWindow): any {
  const tabType = win.Zotero_Tabs?.selectedType;
  if (tabType === "reader") {
    return win.ZoteroContextPane?.activeEditor || null;
  }
  return (win.ZoteroPane as any)?.itemPane?._noteEditor || null;
}

/**
 * Check if an iframe document belongs to the note editor.
 */
function isEditorIframe(iframeEl: HTMLIFrameElement): boolean {
  try {
    const doc = iframeEl.contentDocument;
    if (!doc) return false;
    return (
      doc.body?.isContentEditable ||
      !!doc.querySelector('[contenteditable="true"]')
    );
  } catch {
    return false;
  }
}

/**
 * Iterate all iframes in the main window, returning editor iframe info.
 */
function scanEditorIframes(): {
  iframeEl: HTMLIFrameElement;
  contentWindow: Window;
} | null {
  try {
    const win = Zotero.getMainWindow();
    const iframes = win.document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      const iframeEl = iframe as HTMLIFrameElement;
      if (isEditorIframe(iframeEl)) {
        return { iframeEl, contentWindow: iframeEl.contentWindow! };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Find an iframe element by matching its contentWindow to a given window.
 */
export function getIframeByWindow(
  targetWin: Window,
): { element: HTMLIFrameElement; rect: DOMRect } | null {
  try {
    const win = Zotero.getMainWindow();
    const iframes = win.document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const el = iframe as HTMLIFrameElement;
        if (el.contentWindow === targetWin) {
          return { element: el, rect: el.getBoundingClientRect() };
        }
      } catch {
        /* cross-origin */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function getActiveEditor(): any {
  const win = Zotero.getMainWindow();
  try {
    const editorHost = getEditorHost(win);

    const iframeWin = getIframeWindowFromHost(editorHost);
    if (iframeWin) return iframeWin;

    const scan = scanEditorIframes();
    if (scan) return scan.contentWindow;

    if (editorHost?._editorInstance) return editorHost._editorInstance;
  } catch (e) {
    Zotero.debug(`[FastLink] Error detecting editor: ${e}`);
  }
  return null;
}

export function getEditorWindow(): Window | null {
  const win = Zotero.getMainWindow();
  try {
    const editorHost = getEditorHost(win);

    const iframeWin = getIframeWindowFromHost(editorHost);
    if (iframeWin) return iframeWin;

    const scan = scanEditorIframes();
    if (scan) return scan.contentWindow;

    if (_cachedEditorWindow) return _cachedEditorWindow;
  } catch (e) {
    Zotero.debug(`[FastLink] Error getting editor window: ${e}`);
  }
  return null;
}

export function getEditorIframeElement(): HTMLIFrameElement | null {
  return scanEditorIframes()?.iframeEl ?? null;
}

export function getCurrentNote(): Zotero.Item | null {
  try {
    // Check selected items first (works in standalone note mode)
    const pane = Zotero.getActiveZoteroPane();
    const items = pane.getSelectedItems();
    for (const item of items) {
      if (item.isNote()) return item;
    }

    // In reader mode, the side column note editor is not the selected item.
    // Get the note from the context pane's active editor instead.
    const win = Zotero.getMainWindow();
    const tabType = win.Zotero_Tabs?.selectedType;
    if (tabType === "reader") {
      const editor = win.ZoteroContextPane?.activeEditor;
      if (editor?.item?.isNote()) {
        return editor.item;
      }
    }
  } catch (e) {
    Zotero.debug(`[FastLink] Error getting current note: ${e}`);
  }
  return null;
}

export function isInLinkElement(): boolean {
  try {
    const editor = getActiveEditor();
    if (!editor) return false;

    const selection = editor.getSelection();
    if (!selection || selection.rangeCount === 0) return false;

    const range = selection.getRangeAt(0);
    let node = range.startContainer;

    while (node && node !== (editor as Window).document?.documentElement) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (element.tagName === "A") return true;
      }
      node = node.parentNode;
    }
  } catch (e) {
    Zotero.debug(`[FastLink] Error checking link element: ${e}`);
  }
  return false;
}
