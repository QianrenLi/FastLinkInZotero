// src/utils/editor-caret.ts
// Shared helpers for reading the note editor's caret state. Used by both
// NoteLinkAutocomplete ([[) and SlashCommandHandler (/) so the two features
// share one bounded-text read and one cursor-position capture.
import { getHostWindow, getIframeByWindow } from "./editor-detector";

export interface CursorPosition {
  x: number;
  y: number;
  hostWindow: Window;
}

/**
 * Bounded text immediately before the caret. Reading from a bounded window —
 * not the whole note body — keeps keystroke-time work cheap; falls back to the
 * whole body if bounding fails. `budget` caps how far back we walk.
 */
export function getTextBeforeCaret(
  editorWin: Window | null,
  budget: number,
): string | null {
  if (!editorWin) return null;
  try {
    const body = editorWin.document.body;
    if (!body) return null;

    const selection = editorWin.getSelection();
    if (!selection || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    const prefixRange = range.cloneRange();
    try {
      const startNode = findBoundedRangeStart(
        range.startContainer,
        body,
        budget,
        editorWin.document,
      );
      prefixRange.setStart(startNode, 0);
    } catch {
      prefixRange.selectNodeContents(body);
    }
    prefixRange.setEnd(range.endContainer, range.endOffset);
    return prefixRange.toString();
  } catch (e) {
    Zotero.debug(`[FastLink] getTextBeforeCaret error: ${e}`);
    return null;
  }
}

/**
 * Walk backward from the caret, accumulating text length up to `budget` chars,
 * and return the text node whose offset 0 marks the start of the bounded window.
 */
function findBoundedRangeStart(
  caretContainer: Node,
  body: HTMLElement,
  budget: number,
  doc: Document,
): Node {
  const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  walker.currentNode = caretContainer;

  let collected = 0;
  let earliest: Node = caretContainer;
  let prev = walker.previousNode() as Text | null;
  while (prev && collected < budget) {
    collected += prev.length;
    earliest = prev;
    prev = walker.previousNode() as Text | null;
  }
  return earliest;
}

/**
 * Capture the caret's screen position (x, y below the caret) and the chrome
 * window the popup must anchor in. Translates the iframe-local rect into the
 * host window's coordinate space. Returns null if the position can't be read.
 */
export function captureCursorPosition(
  editorWin: Window | null,
): CursorPosition | null {
  if (!editorWin) return null;
  try {
    let offsetX = 0;
    let offsetY = 0;
    let hostWin: Window = Zotero.getMainWindow();

    const match = getIframeByWindow(editorWin);
    if (match) {
      offsetX = match.rect.left;
      offsetY = match.rect.top;
      hostWin = match.hostWindow;
    } else {
      hostWin = getHostWindow(editorWin) || Zotero.getMainWindow();
    }

    const selection = editorWin.getSelection();
    if (!selection || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    let rect = range.getBoundingClientRect();

    // Collapsed selections return (0,0,0,0) — use a temporary zero-width marker.
    if (rect.width === 0 && rect.height === 0) {
      try {
        const marker = editorWin.document.createElement("span");
        marker.textContent = "​";
        const insertRange = range.cloneRange();
        insertRange.collapse(true);
        insertRange.insertNode(marker);
        rect = marker.getBoundingClientRect();
        marker.parentNode?.removeChild(marker);
      } catch {
        /* ignore */
      }
    }

    return {
      x: rect.left + offsetX,
      y: rect.bottom + offsetY,
      hostWindow: hostWin,
    };
  } catch (e) {
    Zotero.debug(`[FastLink] captureCursorPosition error: ${e}`);
    return null;
  }
}
