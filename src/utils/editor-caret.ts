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

/** Block-level element tags used to find the line/block containing the caret. */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "td",
  "th",
  "dt",
  "dd",
  "section",
  "article",
]);

function closestBlock(node: Node, doc: Document): HTMLElement | null {
  let el: Node | null = node.nodeType === 1 ? node : node.parentElement;
  while (el && el !== doc.body && el !== doc.documentElement) {
    if (
      el.nodeType === 1 &&
      BLOCK_TAGS.has((el as HTMLElement).tagName.toLowerCase())
    ) {
      return el as HTMLElement;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * True if the "/" ending at the caret is at the start of its line/block — i.e.,
 * the text before it within its block element is empty or only whitespace.
 *
 * This complements a "previous character is whitespace" check (which works on
 * the concatenated text) because `Range.toString()` does NOT insert a separator
 * between block elements: a "/" typed at the start of a new paragraph would
 * otherwise appear to be preceded by the previous line's last character, so the
 * slash trigger would wrongly fail at the start of a line.
 */
export function isSlashAtLineStart(editorWin: Window | null): boolean {
  if (!editorWin) return false;
  try {
    const sel = editorWin.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    const doc = editorWin.document;
    const block = closestBlock(range.startContainer, doc);
    if (!block) return false;
    const pre = doc.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(range.startContainer, range.endOffset);
    const s = pre.toString();
    const slashIdx = s.lastIndexOf("/");
    if (slashIdx < 0) return false;
    return s.slice(0, slashIdx).trim() === "";
  } catch (e) {
    Zotero.debug(`[FastLink] isSlashAtLineStart error: ${e}`);
    return false;
  }
}
