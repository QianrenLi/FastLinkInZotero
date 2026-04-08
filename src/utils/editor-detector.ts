// src/utils/editor-detector.ts
export function getActiveEditor(): any {
  const win = Zotero.getMainWindow();
  try {
    const tabType = win.Zotero_Tabs?.selectedType;
    let editorHost = null;

    if (tabType === "reader") {
      // Reader note panel
      editorHost = win.ZoteroContextPane?.activeEditor || null;
    } else {
      // Standalone note or item pane
      editorHost = (win.ZoteroPane as any)?.itemPane?._noteEditor || null;
    }

    // Handle different Zotero versions' editor API
    if (editorHost?._editorInstance) {
      return editorHost._editorInstance;
    } else if (editorHost?._iframeWindow?.editor) {
      return editorHost._iframeWindow.editor;
    }
  } catch (e) {
    Zotero.debug(`[FastLink] Error detecting editor: ${e}`);
  }
  return null;
}

export function getCurrentNote(): Zotero.Item | null {
  try {
    const pane = Zotero.getActiveZoteroPane();
    const items = pane.getSelectedItems();
    for (const item of items) {
      if (item.isNote()) return item;
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

    // Check if we're inside an anchor element
    while (node && node !== editor.documentElement) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (element.tagName === 'A') {
          return true;
        }
      }
      node = node.parentNode;
    }
  } catch (e) {
    Zotero.debug(`[FastLink] Error checking link element: ${e}`);
  }
  return false;
}
