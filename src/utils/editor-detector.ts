// src/utils/editor-detector.ts

let _cachedEditorWindow: Window | null = null;

export function setCachedEditorWindow(win: Window | null): void {
  _cachedEditorWindow = win;
}

/**
 * Every chrome window, including note windows (chrome://zotero/content/
 * note.xhtml) that `Zotero.getWindows()`/`getMainWindows()` do NOT return.
 * Services.wm (the window mediator) is the only enumeration that sees them,
 * so it must come first — otherwise editor-iframe lookup and source-note
 * resolution silently fail for notes opened in their own window.
 */
export function getAllWindows(): _ZoteroTypes.MainWindow[] {
  try {
    const wm = (Services as any).wm;
    if (wm?.getEnumerator) {
      const out: _ZoteroTypes.MainWindow[] = [];
      const e = wm.getEnumerator(null);
      while (e.hasMoreElements()) {
        out.push(e.getNext() as _ZoteroTypes.MainWindow);
      }
      if (out.length) return out;
    }
  } catch {
    /* ignore */
  }
  try {
    const all = (Zotero as any).getWindows?.();
    if (Array.isArray(all) && all.length) {
      return all as _ZoteroTypes.MainWindow[];
    }
  } catch {
    /* ignore */
  }
  try {
    return Zotero.getMainWindows();
  } catch {
    return [];
  }
}

function getIframeWindowFromHost(editorHost: any): Window | null {
  if (editorHost?._iframeWindow) return editorHost._iframeWindow;
  if (editorHost?._iframeElement?.contentWindow)
    return editorHost._iframeElement.contentWindow;
  return null;
}

/**
 * Resolve the editor host object from a given window's tab/pane state.
 * Handles the reader side-column editor, the standalone pane note editor,
 * and notes opened in a separate window (which expose a `<note-editor>`
 * element in their document).
 */
function getEditorHost(win: _ZoteroTypes.MainWindow): any {
  if (!win) return null;
  try {
    const tabType = win.Zotero_Tabs?.selectedType;
    if (tabType === "reader") {
      return win.ZoteroContextPane?.activeEditor || null;
    }
  } catch {
    /* ignore */
  }
  try {
    const paneEditor = (win.ZoteroPane as any)?.itemPane?._noteEditor;
    if (paneEditor) return paneEditor;
  } catch {
    /* ignore */
  }
  // Note opened in its own window: the editor is a <note-editor> element.
  try {
    const el = win.document?.querySelector?.("note-editor");
    if (el) return el;
  } catch {
    /* ignore */
  }
  return null;
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

/** Scan a specific window's iframes for the editor iframe. */
function scanEditorIframesIn(
  win: _ZoteroTypes.MainWindow,
): { iframeEl: HTMLIFrameElement; contentWindow: Window } | null {
  try {
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
 * Search all Zotero windows for an iframe whose contentWindow matches the
 * target. Returns the iframe element, its rect (relative to the host chrome
 * window's viewport), and the host chrome window itself. Used to translate
 * editor-local selection coordinates into host-window coordinates and to
 * anchor the popup in the correct window.
 */
export function getIframeByWindow(targetWin: Window): {
  element: HTMLIFrameElement;
  rect: DOMRect;
  hostWindow: _ZoteroTypes.MainWindow;
} | null {
  for (const win of getAllWindows()) {
    try {
      const iframes = win.document.querySelectorAll("iframe");
      for (const iframe of iframes) {
        try {
          const el = iframe as HTMLIFrameElement;
          if (el.contentWindow === targetWin) {
            return {
              element: el,
              rect: el.getBoundingClientRect(),
              hostWindow: win,
            };
          }
        } catch {
          /* cross-origin */
        }
      }
    } catch {
      /* window may be closed */
    }
  }
  return null;
}

/**
 * Resolve the chrome window that hosts a given editor window. If the editor
 * window is itself a top-level chrome window, return it; otherwise find the
 * chrome window whose document contains the editor iframe. This is what lets
 * the plugin resolve the right note/editor when the user is typing in a note
 * opened in a separate window.
 */
export function getHostWindow(
  editorWin: Window | null | undefined,
): _ZoteroTypes.MainWindow | null {
  if (!editorWin) return null;
  for (const win of getAllWindows()) {
    if (win === editorWin) return win;
  }
  // editorWin is an iframe contentWindow — find its host.
  return getIframeByWindow(editorWin)?.hostWindow ?? null;
}

export function getActiveEditor(win?: _ZoteroTypes.MainWindow): any {
  const host = win || Zotero.getMainWindow();
  try {
    const editorHost = getEditorHost(host);

    const iframeWin = getIframeWindowFromHost(editorHost);
    if (iframeWin) return iframeWin;

    const scan = scanEditorIframesIn(host);
    if (scan) return scan.contentWindow;

    if (editorHost?._editorInstance) return editorHost._editorInstance;
  } catch (e) {
    Zotero.debug(`[FastLink] Error detecting editor: ${e}`);
  }
  return null;
}

export function getEditorWindow(win?: _ZoteroTypes.MainWindow): Window | null {
  const host = win || Zotero.getMainWindow();
  try {
    const editorHost = getEditorHost(host);

    const iframeWin = getIframeWindowFromHost(editorHost);
    if (iframeWin) return iframeWin;

    const scan = scanEditorIframesIn(host);
    if (scan) return scan.contentWindow;

    if (_cachedEditorWindow) return _cachedEditorWindow;
  } catch (e) {
    Zotero.debug(`[FastLink] Error getting editor window: ${e}`);
  }
  return null;
}

export function getEditorIframeElement(): HTMLIFrameElement | null {
  for (const win of getAllWindows()) {
    const scan = scanEditorIframesIn(win);
    if (scan) return scan.iframeEl;
  }
  return null;
}

/**
 * The note editor's editable content root — the element whose innerHTML is the
 * note content (and nothing else). In Zotero 9 the editor iframe's <body>
 * contains the toolbar too, so reading body.innerHTML would pollute the stored
 * note with toolbar markup that compounds on every insertion. We must read the
 * contenteditable element instead. Falls back to <body> when the body itself is
 * contenteditable (older layout).
 */
export function getEditorContentElement(
  editorWin: Window | null,
): HTMLElement | null {
  if (!editorWin?.document) return null;
  try {
    const ce = editorWin.document.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    if (ce) return ce;
    if (editorWin.document.body?.isContentEditable) {
      return editorWin.document.body;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Resolve the note currently being edited.
 *
 * When `editorWin` is supplied (the window the keystroke came from), resolve
 * the note from THAT window's editor host. This is what makes notes opened in
 * a separate window work — there is no selected item or reader tab there, so
 * the main-window fallbacks below would otherwise return the wrong note.
 */
export function getCurrentNote(editorWin?: Window | null): Zotero.Item | null {
  try {
    if (editorWin) {
      const host = getHostWindow(editorWin);
      const editorHost = host ? getEditorHost(host) : null;
      if (editorHost?.item?.isNote?.()) return editorHost.item;
    }

    // Check selected items first (works in standalone note pane mode)
    const pane = Zotero.getActiveZoteroPane();
    const items = pane?.getSelectedItems?.() ?? [];
    for (const item of items) {
      if (item.isNote()) return item;
    }

    // In reader mode, the side column note editor is not the selected item.
    // Get the note from the context pane's active editor instead.
    const win = Zotero.getMainWindow();
    const tabType = win.Zotero_Tabs?.selectedType;
    if (tabType === "reader") {
      const editor = win.ZoteroContextPane?.activeEditor;
      if (editor?.item?.isNote?.()) {
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
      if (node.nodeType === 1 /* Node.ELEMENT_NODE */) {
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
