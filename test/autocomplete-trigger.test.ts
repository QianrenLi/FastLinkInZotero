import { assert } from "chai";
import { NoteLinkAutocomplete } from "../src/modules/note-link-autocomplete";
import { NoteSearchService } from "../src/modules/note-search-service";
import { LinkInserter } from "../src/modules/link-inserter";

describe("[[ Trigger Detection", function () {
  this.timeout(30000);

  let autocomplete: NoteLinkAutocomplete;
  let searchService: NoteSearchService;
  let linkInserter: LinkInserter;

  // The main window in the test harness is a XUL document with no usable
  // <body>/Selection, so we don't build a live editor here. Instead we feed the
  // trigger detector controlled "text before caret" (the state at the moment an
  // `input` event fires — AFTER the just-typed char is in the text) and assert
  // on the trigger *decision*: does `[[` fire the popup and `[` not?
  function fakeEditable() {
    return {
      isContentEditable: true,
      ownerDocument: { defaultView: Zotero.getMainWindow() },
    } as any;
  }

  function mockInput(target: any, data: string): InputEvent {
    return { target, data } as any as InputEvent;
  }

  function mockKeyEvent(key: string): KeyboardEvent {
    return {
      key,
      target: fakeEditable(),
      stopPropagation() {},
      preventDefault() {},
    } as any as KeyboardEvent;
  }

  // Simulate typing `data` while the detector sees `textBeforeCaret` before the
  // caret.
  function typeWith(textBeforeCaret: string | null, data: string): void {
    (autocomplete as any).getTextBeforeCaret = () => textBeforeCaret;
    (autocomplete as any).handleInput(mockInput(fakeEditable(), data));
  }

  function resetState() {
    (autocomplete as any).isActive = false;
    (autocomplete as any)._lastEditorWindow = Zotero.getMainWindow();
    (autocomplete as any)._savedCursorPos = null;
    // Drop any per-test stub so it can't leak into the next test.
    delete (autocomplete as any).getTextBeforeCaret;
  }

  before(function () {
    searchService = new NoteSearchService();
    linkInserter = new LinkInserter();
    autocomplete = new NoteLinkAutocomplete(searchService, linkInserter);
  });

  after(function () {
    autocomplete.destroy();
    searchService.clearCache();
  });

  it("should trigger when [[ is present before the caret", function () {
    resetState();
    typeWith("[[", "[");
    assert.isTrue(
      (autocomplete as any).isActive,
      "Autocomplete should trigger when [[ precedes the caret",
    );
    (autocomplete as any).closePopup();
  });

  it("should NOT trigger on a single [ before the caret", function () {
    resetState();
    typeWith("x[", "[");
    assert.isFalse(
      (autocomplete as any).isActive,
      "A single [ must not trigger",
    );
  });

  it("should NOT trigger when a [ is followed by a non-bracket", function () {
    resetState();
    typeWith("x[", "a");
    assert.isFalse(
      (autocomplete as any).isActive,
      "Typing a non-bracket after [ must not trigger",
    );
  });

  it("should NOT trigger when the caret is past an earlier [[", function () {
    resetState();
    // "[[" exists earlier in the line but the caret is after "cd".
    typeWith("ab[[cd", "[");
    assert.isFalse(
      (autocomplete as any).isActive,
      "Caret past an earlier [[ must not trigger",
    );
  });

  it("should ignore input events on non-contentEditable targets", function () {
    resetState();
    const nonEditable = {
      isContentEditable: false,
      ownerDocument: { defaultView: Zotero.getMainWindow() },
    };
    (autocomplete as any).getTextBeforeCaret = () => "[[";
    (autocomplete as any).handleInput(mockInput(nonEditable, "["));
    assert.isFalse(
      (autocomplete as any).isActive,
      "Should not trigger on non-contentEditable elements",
    );
  });

  it("should close popup on Escape when active", function () {
    resetState();
    typeWith("[[", "[");
    assert.isTrue((autocomplete as any).isActive);

    (autocomplete as any).handleKeyDown(mockKeyEvent("Escape"));
    assert.isFalse(
      (autocomplete as any).isActive,
      "Should deactivate on Escape",
    );
    (autocomplete as any).closePopup();
  });
});
