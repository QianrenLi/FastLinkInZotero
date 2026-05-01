import { assert } from "chai";
import { getPref, setPref } from "../src/utils/prefs";
import { createNote } from "../src/modules/note-link-autocomplete";
import { LinkInserter } from "../src/modules/link-inserter";

describe("better-notes-compat", function () {
  this.timeout(30000);

  const createdNotes: Zotero.Item[] = [];
  let originalMode: string;

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

  before(function () {
    originalMode = getPref("linkMode");
  });

  after(async function () {
    setPref("linkMode", originalMode as any);
    await cleanupNotes();
  });

  it("should have Better Notes plugin installed", function () {
    assert.isDefined(
      Zotero.BetterNotes,
      "Zotero.BetterNotes should be defined",
    );
  });

  it("should generate zotero://note/u/{key}/ links in better-notes mode", async function () {
    setPref("linkMode", "better-notes");

    const sourceNote = await createTestNote("<p>See [[my topic here</p>");
    const targetNote = await createNote(
      Zotero.Libraries.userLibraryID,
      "my topic",
    );
    assert.isNotNull(targetNote);
    createdNotes.push(targetNote!);

    const inserter = new LinkInserter();
    const result = await inserter.insertLink({
      noteId: targetNote!.id,
      noteTitle: "my topic",
      triggerText: "my topic",
      liveHtml: sourceNote.getNote(),
      sourceNoteId: sourceNote.id,
    });

    assert.isTrue(result, "insertLink should succeed");

    const updated = await Zotero.Items.getAsync(sourceNote.id);
    const html = updated.getNote();
    const expectedUri = `zotero://note/u/${targetNote!.key}/`;
    assert.include(html, expectedUri, "Should contain Better Notes format URI");
    assert.include(html, ">my topic</a>");
    assert.notInclude(html, "[[my topic");
  });

  it("should have zotero://note protocol handler registered by Better Notes", function () {
    try {
      const handler =
        Services.io.getProtocolHandler("zotero").wrappedJSObject._extensions[
          "zotero://note"
        ];
      assert.isDefined(handler, "zotero://note extension should be registered");
    } catch (e) {
      assert.fail(`Could not access protocol handler: ${e}`);
    }
  });
});
