import { assert } from "chai";
import { NoteLinkAutocomplete } from "../src/modules/note-link-autocomplete";
import { NoteSearchService } from "../src/modules/note-search-service";
import { LinkInserter } from "../src/modules/link-inserter";

describe("[[ Trigger Detection", function () {
  this.timeout(30000);

  let autocomplete: NoteLinkAutocomplete;
  let searchService: NoteSearchService;
  let linkInserter: LinkInserter;

  function createMockKeyEvent(
    key: string,
    code: string,
    target?: any,
  ): KeyboardEvent {
    return {
      key,
      code,
      target:
        target ||
        ({
          isContentEditable: true,
          ownerDocument: { defaultView: Zotero.getMainWindow() },
          getBoundingClientRect: () => ({
            left: 100,
            top: 200,
            width: 400,
            height: 20,
          }),
        } as any),
      stopPropagation() {},
      preventDefault() {},
    } as any as KeyboardEvent;
  }

  function resetState() {
    (autocomplete as any).triggerBuffer = "";
    (autocomplete as any).lastKeyTime = 0;
    (autocomplete as any).isActive = false;
    (autocomplete as any)._triggerTarget = null;
    (autocomplete as any)._savedCursorPos = null;
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

  it("should trigger autocomplete on double [ keypress within timeout", function () {
    resetState();

    const event1 = createMockKeyEvent("[", "BracketLeft");
    (autocomplete as any).handleKeyDown(event1);

    const event2 = createMockKeyEvent("[", "BracketLeft");
    (autocomplete as any).handleKeyDown(event2);

    assert.isTrue(
      (autocomplete as any).isActive,
      "Autocomplete should be active after double [",
    );
    assert.equal(
      (autocomplete as any).triggerBuffer,
      "",
      "Trigger buffer should be cleared after double [",
    );

    (autocomplete as any).closePopup();
  });

  it("should not trigger on single [ keypress", function () {
    resetState();

    const event = createMockKeyEvent("[", "BracketLeft");
    (autocomplete as any).handleKeyDown(event);

    assert.isFalse(
      (autocomplete as any).isActive,
      "Autocomplete should not be active after single [",
    );
    assert.equal(
      (autocomplete as any).triggerBuffer,
      "[",
      "Trigger buffer should store [",
    );
    assert.isAbove(
      (autocomplete as any).lastKeyTime,
      0,
      "lastKeyTime should be recorded",
    );
  });

  it("should reset trigger buffer on non-bracket key", function () {
    resetState();

    const event1 = createMockKeyEvent("[", "BracketLeft");
    (autocomplete as any).handleKeyDown(event1);

    const event2 = createMockKeyEvent("a", "KeyA");
    (autocomplete as any).handleKeyDown(event2);

    assert.equal(
      (autocomplete as any).triggerBuffer,
      "",
      "Trigger buffer should be reset on non-bracket key",
    );
    assert.isFalse(
      (autocomplete as any).isActive,
      "Autocomplete should not be active",
    );
  });

  it("should not trigger when [ keys are too far apart (>500ms)", function (done) {
    resetState();

    const event1 = createMockKeyEvent("[", "BracketLeft");
    (autocomplete as any).handleKeyDown(event1);

    setTimeout(() => {
      const event2 = createMockKeyEvent("[", "BracketLeft");
      (autocomplete as any).handleKeyDown(event2);

      assert.isFalse(
        (autocomplete as any).isActive,
        "Autocomplete should not activate with slow [ presses",
      );
      assert.equal(
        (autocomplete as any).triggerBuffer,
        "[",
        "Buffer should be [ (fresh press, not double)",
      );
      done();
    }, 550);
  });

  it("should ignore events on non-contentEditable targets", function () {
    resetState();

    const nonEditableTarget = {
      isContentEditable: false,
      ownerDocument: { defaultView: Zotero.getMainWindow() },
    };

    const event1 = createMockKeyEvent("[", "BracketLeft", nonEditableTarget);
    (autocomplete as any).handleKeyDown(event1);

    const event2 = createMockKeyEvent("[", "BracketLeft", nonEditableTarget);
    (autocomplete as any).handleKeyDown(event2);

    assert.isFalse(
      (autocomplete as any).isActive,
      "Should not trigger on non-contentEditable elements",
    );
    assert.equal(
      (autocomplete as any).triggerBuffer,
      "",
      "Buffer should remain empty",
    );
  });

  it("should store _triggerTarget on first [ press", function () {
    resetState();

    const target = {
      isContentEditable: true,
      ownerDocument: { defaultView: Zotero.getMainWindow() },
    };

    const event = createMockKeyEvent("[", "BracketLeft", target);
    (autocomplete as any).handleKeyDown(event);

    assert.strictEqual(
      (autocomplete as any)._triggerTarget,
      target,
      "_triggerTarget should be set to the event target",
    );
  });

  it("should detect [[ via BracketLeft code (IME compatibility)", function () {
    resetState();

    const event1 = createMockKeyEvent("Process", "BracketLeft");
    (autocomplete as any).handleKeyDown(event1);

    const event2 = createMockKeyEvent("Process", "BracketLeft");
    (autocomplete as any).handleKeyDown(event2);

    assert.isTrue(
      (autocomplete as any).isActive,
      "Should trigger on BracketLeft code even with non-[ key value",
    );

    (autocomplete as any).closePopup();
  });

  it("should close popup on Escape when active", function () {
    resetState();

    // Trigger autocomplete
    const event1 = createMockKeyEvent("[", "BracketLeft");
    (autocomplete as any).handleKeyDown(event1);
    const event2 = createMockKeyEvent("[", "BracketLeft");
    (autocomplete as any).handleKeyDown(event2);

    assert.isTrue((autocomplete as any).isActive);

    // Press Escape
    const escapeEvent = createMockKeyEvent("Escape", "Escape");
    (autocomplete as any).handleKeyDown(escapeEvent);

    assert.isFalse(
      (autocomplete as any).isActive,
      "Should deactivate on Escape",
    );
  });
});
