import { assert } from "chai";
import { escapeHtml, escapeRegex } from "../src/utils/html";
import { debounce } from "../src/utils/debounce";
import { NoteSearchService } from "../src/modules/note-search-service";

describe("HTML Utilities", function () {
  it("escapeHtml should escape all special characters", function () {
    assert.equal(escapeHtml("&<>\"'"), "&amp;&lt;&gt;&quot;&#039;");
  });

  it("escapeHtml should leave normal text unchanged", function () {
    assert.equal(escapeHtml("Hello World 123"), "Hello World 123");
  });

  it("escapeHtml should handle empty string", function () {
    assert.equal(escapeHtml(""), "");
  });

  it("escapeHtml should handle multiple occurrences", function () {
    assert.equal(escapeHtml("a & b & c"), "a &amp; b &amp; c");
  });

  it("escapeRegex should escape regex special characters", function () {
    assert.equal(escapeRegex("a.b*c+d?e"), "a\\.b\\*c\\+d\\?e");
  });

  it("escapeRegex should escape brackets and parens", function () {
    assert.equal(escapeRegex("[test](group)"), "\\[test\\]\\(group\\)");
  });

  it("escapeRegex should escape braces and pipes", function () {
    assert.equal(escapeRegex("{a|b}"), "\\{a\\|b\\}");
  });

  it("escapeRegex should leave normal text unchanged", function () {
    assert.equal(escapeRegex("hello world"), "hello world");
  });
});

describe("Debounce", function () {
  it("should delay function execution", function (done) {
    let callCount = 0;
    const fn = debounce(() => {
      callCount++;
    }, 100);

    fn();
    assert.equal(callCount, 0, "Should not be called immediately");

    setTimeout(() => {
      assert.equal(callCount, 1, "Should be called after delay");
      done();
    }, 150);
  });

  it("should only execute once for rapid calls", function (done) {
    let callCount = 0;
    const fn = debounce(() => {
      callCount++;
    }, 100);

    fn();
    fn();
    fn();
    fn();

    setTimeout(() => {
      assert.equal(callCount, 1, "Should only be called once");
      done();
    }, 150);
  });

  it("should pass arguments to the debounced function", function (done) {
    let received: string[] = [];
    const fn = debounce((args: string[]) => {
      received = args;
    }, 50);

    fn(["a", "b"]);

    setTimeout(() => {
      assert.deepEqual(received, ["a", "b"]);
      done();
    }, 100);
  });
});

describe("NoteSearchService", function () {
  this.timeout(30000);

  let service: NoteSearchService;
  const createdNotes: Zotero.Item[] = [];

  async function createAndRegisterNote(title: string): Promise<Zotero.Item> {
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.setNote(title);
    await note.saveTx();
    createdNotes.push(note);
    return note;
  }

  async function cleanup() {
    service.clearCache();
    for (const note of createdNotes) {
      try {
        await note.eraseTx();
      } catch {
        /* already deleted */
      }
    }
    createdNotes.length = 0;
  }

  before(async function () {
    service = new NoteSearchService();

    await createAndRegisterNote("Meeting Notes");
    await createAndRegisterNote("Meeting Agenda");
    await createAndRegisterNote("Project Alpha");
    await createAndRegisterNote("Project Beta Notes");
    await createAndRegisterNote("Random Thoughts");

    await service.buildCache();
  });

  after(async function () {
    await cleanup();
  });

  it("should build cache with correct note count", function () {
    assert.isTrue(service.isCacheBuilt());
    // At least our 5 notes (there may be others)
    const results = service.search("");
    assert.isAtLeast(results.length, 5);
  });

  it("should find exact match", function () {
    const results = service.search("Meeting Notes");
    assert.isAbove(results.length, 0);
    assert.equal(results[0].matchType, "exact");
    assert.equal(results[0].note.title, "Meeting Notes");
  });

  it("should find prefix matches", function () {
    const results = service.search("Project");
    assert.isAbove(results.length, 0);
    const prefixMatches = results.filter(
      (r) => r.matchType === "prefix" || r.matchType === "exact",
    );
    assert.isAbove(prefixMatches.length, 0, "Should find prefix matches");

    for (const r of prefixMatches) {
      assert.include(r.note.lowerTitle, "project");
    }
  });

  it("should find contains matches", function () {
    const results = service.search("thoughts");
    assert.isAbove(results.length, 0);
    const containsMatches = results.filter((r) => r.matchType === "contains");
    assert.isAbove(containsMatches.length, 0, "Should find contains matches");
  });

  it("should rank exact matches before prefix before contains", function () {
    const results = service.search("meeting");
    if (results.length < 2) return; // skip if not enough results

    let lastOrder = -1;
    const matchTypeOrder = { exact: 0, prefix: 1, contains: 2 };
    for (const r of results) {
      const currentOrder = matchTypeOrder[r.matchType];
      assert.isAtLeast(
        currentOrder,
        lastOrder,
        `Results should be sorted: exact > prefix > contains`,
      );
      lastOrder = currentOrder;
    }
  });

  it("should return empty results for non-matching query", function () {
    const results = service.search("ZZZ_NONEXISTENT_NOTE_ZZZ");
    assert.equal(results.length, 0);
  });

  it("should be case-insensitive", function () {
    const lower = service.search("meeting notes");
    const upper = service.search("MEETING NOTES");
    assert.equal(lower.length, upper.length);
  });
});

describe("NoteSearchService - cache management", function () {
  this.timeout(30000);

  it("should return empty results when cache is not built", function () {
    const svc = new NoteSearchService();
    svc.clearCache();
    const results = svc.search("Anything");
    assert.equal(results.length, 0);
    assert.isArray(results);
  });
});
