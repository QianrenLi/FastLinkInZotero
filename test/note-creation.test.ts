import { assert } from "chai";
import { createNote } from "../src/modules/note-link-autocomplete";
import { PopupController, PopupItem } from "../src/modules/popup-controller";

describe("Note Creation via [[", function () {
  this.timeout(30000);

  const createdNotes: Zotero.Item[] = [];

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

  it("should create a standalone note with correct title", async function () {
    const libraryID = Zotero.Libraries.userLibraryID;
    const note = await createNote(libraryID, "Test Note Creation");

    assert.isNotNull(note, "createNote should return a note");
    assert.instanceOf(note!, Zotero.Item, "Should return a Zotero.Item");
    assert.equal(note!.getField("title"), "Test Note Creation");
    assert.isTrue(note!.isNote(), "Should be a note item");
    assert.isFalse(!!note!.parentID, "Should be a standalone note (no parent)");

    createdNotes.push(note!);
  });

  it("should store HTML-escaped title as note content", async function () {
    const libraryID = Zotero.Libraries.userLibraryID;
    const title = 'Note with <special> & "chars"';
    const note = await createNote(libraryID, title);

    assert.isNotNull(note);
    const noteContent = note!.getNote();
    assert.include(noteContent, "&lt;special&gt;");
    assert.include(noteContent, "&amp;");
    assert.include(noteContent, "&quot;");
    assert.equal(note!.getNoteTitle(), title);

    createdNotes.push(note!);
  });

  it("should trim whitespace from title", async function () {
    const libraryID = Zotero.Libraries.userLibraryID;
    const note = await createNote(libraryID, "  Trimmed Title  ");

    assert.isNotNull(note);
    assert.equal(note!.getField("title"), "Trimmed Title");

    createdNotes.push(note!);
  });

  it("should return null on invalid library", async function () {
    const note = await createNote(999999, "Invalid Library");
    assert.isNull(note, "Should return null for invalid library ID");
  });
});

describe("Popup 'Create New' Selection", function () {
  this.timeout(30000);

  let popup: PopupController;
  let lastSelection: {
    noteId: number | null;
    noteTitle: string;
    searchQuery: string;
  } | null = null;

  beforeEach(function () {
    lastSelection = null;
    popup = new PopupController({
      onSelection(noteId, noteTitle, searchQuery) {
        lastSelection = { noteId, noteTitle, searchQuery };
      },
      onClose() {},
    });
  });

  afterEach(function () {
    popup.destroy();
  });

  it("should call onSelection with null noteId for 'Create new'", function () {
    const items: PopupItem[] = [
      { noteId: 1, title: "Existing Note", matchType: "exact" },
    ];
    popup.setItems(items);
    popup.updateQuery("New Note Idea");

    // The "Create new" option is at index === items.length (1)
    // Simulate selecting it via handleKeyDown
    (popup as any).selectedIndex = 1;
    (popup as any).selectCurrent();

    assert.isNotNull(lastSelection);
    assert.isNull(
      lastSelection!.noteId,
      "noteId should be null for create-new",
    );
    assert.equal(
      lastSelection!.noteTitle,
      "New Note Idea",
      "Title should be the query text",
    );
    assert.equal(
      lastSelection!.searchQuery,
      "New Note Idea",
      "Search query should match",
    );
  });

  it("should call onSelection with noteId for existing note", function () {
    const items: PopupItem[] = [
      { noteId: 42, title: "My Note", matchType: "exact" },
      { noteId: 43, title: "Other Note", matchType: "prefix" },
    ];
    popup.setItems(items);

    (popup as any).selectedIndex = 0;
    (popup as any).selectCurrent();

    assert.isNotNull(lastSelection);
    assert.equal(lastSelection!.noteId, 42);
    assert.equal(lastSelection!.noteTitle, "My Note");
  });

  it("should create 'Create new' option when query is non-empty", function () {
    const items: PopupItem[] = [];
    popup.setItems(items);
    popup.updateQuery("Search Term");

    assert.isTrue(
      (popup as any).hasCreateOption(),
      "Should show create option with non-empty query",
    );
  });

  it("should not show 'Create new' option when query is empty", function () {
    const items: PopupItem[] = [
      { noteId: 1, title: "Note", matchType: "exact" },
    ];
    popup.setItems(items);
    popup.updateQuery("");

    assert.isFalse(
      (popup as any).hasCreateOption(),
      "Should not show create option with empty query",
    );
  });
});
