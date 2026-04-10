// src/modules/link-inserter.ts
import { getActiveEditor } from '../utils/editor-detector';

export interface LinkInsertOptions {
  noteId: number;
  noteTitle: string;
}

export class LinkInserter {
  /**
   * Insert a note link at the current cursor position
   */
  async insertLink(options: LinkInsertOptions): Promise<boolean> {
    const { noteId, noteTitle } = options;
    const editor = getActiveEditor();

    if (!editor) {
      Zotero.debug('[FastLink] No active editor found');
      return false;
    }

    try {
      // Generate Zotero native link URI
      const linkUri = `zotero://note/${noteId}`;

      // Create HTML link with note title as display text
      const escapedTitle = this.escapeHtml(noteTitle);
      const linkHtml = `<a href="${linkUri}">${escapedTitle}</a>`;

      // Insert using editor's API
      if (typeof editor.execCommand === 'function') {
        editor.execCommand('insertHTML', false, linkHtml);
      } else {
        // Fallback for different editor versions
        const selection = editor.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          range.deleteContents();

          const fragment = range.createContextualFragment(linkHtml);
          range.insertNode(fragment);

          // Move cursor after the link
          range.setStartAfter(fragment.lastChild || fragment);
          range.setEndAfter(fragment.lastChild || fragment);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }

      Zotero.debug(`[FastLink] Inserted link to note: ${noteTitle}`);
      return true;
    } catch (e) {
      Zotero.debug(`[FastLink] Error inserting link: ${e}`);
      return false;
    }
  }

  /**
   * Remove trigger text ([[ and any typed filter) from editor
   */
  removeTriggerText(triggerLength: number): void {
    const editor = getActiveEditor();
    if (!editor) return;

    try {
      const selection = editor.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);

      // Move backward by triggerLength characters
      const textRange = editor.document!.createRange();
      textRange.setStart(range.startContainer, range.startOffset - triggerLength);
      textRange.setEnd(range.startContainer, range.startOffset);
      textRange.deleteContents();
    } catch (e) {
      Zotero.debug(`[FastLink] Error removing trigger text: ${e}`);
    }
  }

  /**
   * Escape HTML for safe insertion
   */
  private escapeHtml(text: string): string {
    const editor = getActiveEditor();
    if (!editor) {
      // Fallback if no editor available
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    const div = editor.document!.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Copy link to clipboard as fallback
   */
  async copyLinkToClipboard(noteId: number, noteTitle: string): Promise<boolean> {
    try {
      const linkUri = `zotero://note/${noteId}`;
      const escapedTitle = this.escapeHtml(noteTitle);
      const linkHtml = `<a href="${linkUri}">${escapedTitle}</a>`;
      const plainText = `${noteTitle} (${linkUri})`;

      // Try HTML+Text clipboard first (may not be available in all Zotero versions)
      const internal = Zotero.Utilities.Internal as any;
      if (internal && typeof internal.copyHTMLToClipboard === 'function') {
        internal.copyHTMLToClipboard(linkHtml, plainText);
        return true;
      }

      // Fallback to text only
      if (internal && typeof internal.copyTextToClipboard === 'function') {
        internal.copyTextToClipboard(plainText);
        return true;
      }

      Zotero.debug('[FastLink] No clipboard API available');
      return false;
    } catch (e) {
      Zotero.debug(`[FastLink] Error copying to clipboard: ${e}`);
      return false;
    }
  }
}
