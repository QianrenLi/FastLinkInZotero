import { assert } from "chai";
import { LinkInserter } from "../src/modules/link-inserter";
import { createNote } from "../src/modules/note-link-autocomplete";

describe("link-insertion", function () {
  describe("LinkInserter - HTML Replacement", function () {
    this.timeout(30000);

    let inserter: LinkInserter;

    beforeEach(function () {
      inserter = new LinkInserter();
    });

    function replaceInHtml(
      html: string,
      fullTrigger: string,
      linkHtml: string,
    ): string | null {
      return (inserter as any).replaceInHtml(html, fullTrigger, linkHtml);
    }

    it("should replace [[query with link in plain text HTML", function () {
      const html = "<p>Before [[query after</p>";
      const linkHtml =
        '<a href="zotero://select/library/items/ABC123">query</a>';

      const result = replaceInHtml(html, "[[query", linkHtml);
      assert.isNotNull(result);
      assert.include(result!, linkHtml);
      assert.include(result!, "Before");
      assert.include(result!, "after");
      assert.notInclude(result!, "[[query");
    });

    it("should replace cross-tag [[query where text after brackets spans tags", function () {
      // [[ is a literal string, but "query" is split by a tag
      const html = "<p>Before [[<b>query</b> after</p>";
      const linkHtml =
        '<a href="zotero://select/library/items/ABC123">query</a>';

      const result = replaceInHtml(html, "[[query", linkHtml);
      assert.isNotNull(result);
      assert.include(result!, linkHtml);
      assert.include(result!, "Before");
      assert.include(result!, "after");
    });

    it("should return null when trigger is not found", function () {
      const html = "<p>No trigger here</p>";
      const linkHtml =
        '<a href="zotero://select/library/items/ABC123">query</a>';

      const result = replaceInHtml(html, "[[query", linkHtml);
      assert.isNull(result);
    });

    it("should handle empty HTML", function () {
      const result = replaceInHtml("", "[[query", "<a>link</a>");
      assert.isNull(result);
    });

    it("should replace the last [[ occurrence when multiple exist", function () {
      const html = "<p>First [[one and second [[query end</p>";
      const linkHtml =
        '<a href="zotero://select/library/items/ABC123">query</a>';

      const result = replaceInHtml(html, "[[query", linkHtml);
      assert.isNotNull(result);
      assert.include(result!, "[[one");
      assert.include(result!, linkHtml);
      assert.notInclude(result!, "[[query");
    });

    it("should strip ProseMirror-specific markup", function () {
      const html =
        '<p contenteditable="false" class="ProseMirror">Text<br class="ProseMirror-trailingBreak"/></p>';
      const cleaned = (inserter as any).cleanProseMirrorHtml(html);

      assert.notInclude(cleaned, "contenteditable");
      assert.notInclude(cleaned, "ProseMirror-trailingBreak");
      assert.notInclude(cleaned, 'class="ProseMirror"');
      assert.include(cleaned, "Text");
    });

    it("should collapse duplicate </p> tags", function () {
      const html = "<p>A</p></p><p>B</p>";
      const cleaned = (inserter as any).cleanProseMirrorHtml(html);

      assert.include(cleaned, "<p>A</p>");
      assert.include(cleaned, "<p>B</p>");
    });
  });

  /**
   * Integration test: verify link insertion works correctly via Zotero API,
   * including when the target note was just created by createNote().
   *
   * This tests the critical flow: user types [[, selects "Create new",
   * a new note is created, and the link is inserted back in the source note.
   */
  describe("LinkInserter - Integration with Note Creation", function () {
    this.timeout(30000);

    const createdNotes: Zotero.Item[] = [];

    async function createTestNote(content: string): Promise<Zotero.Item> {
      const note = new Zotero.Item("note");
      note.libraryID = Zotero.Libraries.userLibraryID;
      note.setNote(content);
      await note.saveTx();
      createdNotes.push(note);
      return note;
    }

    async function cleanupNotes() {
      for (const note of createdNotes) {
        try {
          await note.eraseTx();
        } catch {
          /* already deleted */
        }
      }
      createdNotes.length = 0;
    }

    after(async function () {
      await cleanupNotes();
    });

    it("should insert link using preCapturedHtml (liveHtml)", async function () {
      const libraryID = Zotero.Libraries.userLibraryID;

      // Create source note with [[query in its content
      const sourceNote = await createTestNote(
        "<p>Some text [[query more text</p>",
      );

      // Simulate capturing the live HTML before any async work
      const capturedHtml = sourceNote.getNote();

      // Create a new target note (simulating "Create new" selection)
      const targetNote = await createNote(libraryID, "query");
      assert.isNotNull(targetNote);
      createdNotes.push(targetNote!);

      // Insert link from source to target using the pre-captured HTML
      const inserter = new LinkInserter();
      const result = await inserter.insertLink({
        noteId: targetNote!.id,
        noteTitle: "query",
        triggerText: "query",
        liveHtml: capturedHtml,
        sourceNoteId: sourceNote.id,
      });

      assert.isTrue(result, "insertLink should return true");

      // Reload source note and verify
      const updated = await Zotero.Items.getAsync(sourceNote.id);
      const html = updated.getNote();

      assert.include(html, `zotero://select/library/items/${targetNote!.key}`);
      assert.include(html, ">query</a>");
      assert.include(html, "Some text");
      assert.include(html, "more text");
      assert.notInclude(html, "[[query");
    });

    it("should preserve all surrounding content when inserting link", async function () {
      const libraryID = Zotero.Libraries.userLibraryID;

      const sourceNote = await createTestNote(
        "<h1>Title</h1><p>Paragraph one</p><p>Link: [[target here</p><p>Paragraph two</p>",
      );

      const capturedHtml = sourceNote.getNote();
      const targetNote = await createNote(libraryID, "target");
      createdNotes.push(targetNote!);

      const inserter = new LinkInserter();
      await inserter.insertLink({
        noteId: targetNote!.id,
        noteTitle: "target",
        triggerText: "target",
        liveHtml: capturedHtml,
        sourceNoteId: sourceNote.id,
      });

      const updated = await Zotero.Items.getAsync(sourceNote.id);
      const html = updated.getNote();

      assert.include(html, "<h1>Title</h1>");
      assert.include(html, "Paragraph one");
      assert.include(html, "Paragraph two");
      assert.include(html, `zotero://select/library/items/${targetNote!.key}`);
      assert.notInclude(html, "[[target");
    });

    it("link insertion should not be affected by creating a new note (main doc)", async function () {
      // This is the critical test for requirement 3:
      // Even when createNote() is called (which may change the editor context),
      // the link insertion must still work correctly on the original source note.

      const libraryID = Zotero.Libraries.userLibraryID;

      // 1. Create a source note with realistic content
      const sourceNote = await createTestNote(
        "<p>Working on project notes. See [[meeting notes for details.</p><p>Another paragraph.</p>",
      );

      // 2. Capture the live HTML BEFORE creating the new note
      //    (this is what handleSelection does synchronously before any async work)
      const preCapturedHtml = sourceNote.getNote();

      // 3. Create the new target note via createNote
      //    (simulates what happens when user selects "Create new: meeting notes")
      const newNote = await createNote(libraryID, "meeting notes");
      assert.isNotNull(newNote, "New note should be created");
      createdNotes.push(newNote!);

      // 4. Verify the new note exists and is independent
      const loadedNew = await Zotero.Items.getAsync(newNote!.id);
      assert.isTrue(loadedNew.isNote());
      assert.equal(loadedNew.getNoteTitle(), "meeting notes");

      // 5. Insert the link in the source note, using the pre-captured HTML
      //    and the sourceNoteId (not relying on editor state)
      const inserter = new LinkInserter();
      const result = await inserter.insertLink({
        noteId: newNote!.id,
        noteTitle: "meeting notes",
        triggerText: "meeting notes",
        liveHtml: preCapturedHtml,
        sourceNoteId: sourceNote.id,
      });

      assert.isTrue(result, "Link insertion should succeed");

      // 6. Verify the source note content is correct
      const updatedSource = await Zotero.Items.getAsync(sourceNote.id);
      const sourceHtml = updatedSource.getNote();

      // The link should be inserted
      assert.include(
        sourceHtml,
        `zotero://select/library/items/${newNote!.key}`,
        "Source should contain link to new note",
      );
      assert.include(
        sourceHtml,
        ">meeting notes</a>",
        "Link text should be the query",
      );

      // The surrounding content should be preserved
      assert.include(
        sourceHtml,
        "Working on project notes. See",
        "Text before [[ should be preserved",
      );
      assert.include(
        sourceHtml,
        "for details.",
        "Text after the query should be preserved",
      );
      assert.include(
        sourceHtml,
        "Another paragraph.",
        "Other paragraphs should be preserved",
      );

      // The trigger should be gone
      assert.notInclude(
        sourceHtml,
        "[[meeting notes",
        "The [[trigger should be replaced",
      );
    });

    it("should handle link insertion with empty liveHtml (fallback to cleanHtml)", async function () {
      const libraryID = Zotero.Libraries.userLibraryID;

      const sourceNote = await createTestNote(
        "<p>Fallback test [[query end</p>",
      );
      const targetNote = await createNote(libraryID, "query");
      createdNotes.push(targetNote!);

      const inserter = new LinkInserter();
      // No liveHtml provided — should fall back to currentNote.getNote()
      const result = await inserter.insertLink({
        noteId: targetNote!.id,
        noteTitle: "query",
        triggerText: "query",
        sourceNoteId: sourceNote.id,
      });

      assert.isTrue(result, "Should succeed using clean HTML fallback");

      const updated = await Zotero.Items.getAsync(sourceNote.id);
      const html = updated.getNote();
      assert.include(html, `zotero://select/library/items/${targetNote!.key}`);
      assert.notInclude(html, "[[query");
    });

    it("should insert link with sourceNoteId even when no note is in selection", async function () {
      // Simulates reader mode: no note in getSelectedItems(),
      // but sourceNoteId was captured from context pane editor.
      const libraryID = Zotero.Libraries.userLibraryID;

      const sourceNote = await createTestNote(
        "<p>Side column test [[topic link</p>",
      );
      const targetNote = await createNote(libraryID, "topic");
      createdNotes.push(targetNote!);

      const capturedHtml = sourceNote.getNote();

      // The key: sourceNoteId is provided (captured from editor.item),
      // so insertLink doesn't need to call getCurrentNote()
      const inserter = new LinkInserter();
      const result = await inserter.insertLink({
        noteId: targetNote!.id,
        noteTitle: "topic",
        triggerText: "topic",
        liveHtml: capturedHtml,
        sourceNoteId: sourceNote.id,
      });

      assert.isTrue(
        result,
        "Should succeed using explicit sourceNoteId (reader mode path)",
      );

      const updated = await Zotero.Items.getAsync(sourceNote.id);
      const html = updated.getNote();
      assert.include(html, `zotero://select/library/items/${targetNote!.key}`);
      assert.include(html, "Side column test");
      assert.include(html, "link");
      assert.notInclude(html, "[[topic");
    });
  });
}); // link-insertion
