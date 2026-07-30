import { assert } from "chai";
import {
  SLASH_COMMANDS,
  filterByPrefix,
  findExact,
  isContinuousWord,
  shouldTriggerSlash,
} from "../src/modules/slash-commands";

describe("slash-commands", function () {
  describe("isContinuousWord", function () {
    it("accepts alphanumeric and hyphen words", function () {
      assert.isTrue(isContinuousWord("todo"));
      assert.isTrue(isContinuousWord("to-do"));
      assert.isTrue(isContinuousWord("TODO"));
      assert.isTrue(isContinuousWord("h1"));
    });
    it("rejects empty, spaces, slashes, punctuation", function () {
      assert.isFalse(isContinuousWord(""));
      assert.isFalse(isContinuousWord("to do"));
      assert.isFalse(isContinuousWord("/todo"));
      assert.isFalse(isContinuousWord("todo!"));
    });
  });

  describe("filterByPrefix", function () {
    it("returns all commands for an empty word", function () {
      assert.equal(
        filterByPrefix(SLASH_COMMANDS, "").length,
        SLASH_COMMANDS.length,
      );
    });
    it("matches case-insensitively by prefix", function () {
      const r = filterByPrefix(SLASH_COMMANDS, "TO");
      assert.equal(r.length, 1);
      assert.equal(r[0].trigger, "todo");
    });
    it("matches only done for d", function () {
      const d = filterByPrefix(SLASH_COMMANDS, "d");
      assert.equal(d.length, 1);
      assert.equal(d[0].trigger, "done");
    });
    it("returns nothing for a non-matching prefix", function () {
      assert.equal(filterByPrefix(SLASH_COMMANDS, "xyz").length, 0);
    });
  });

  describe("findExact", function () {
    it("finds an exact case-insensitive match", function () {
      assert.equal(findExact(SLASH_COMMANDS, "Todo")?.trigger, "todo");
    });
    it("returns null when no exact match", function () {
      assert.isNull(findExact(SLASH_COMMANDS, "tod"));
      assert.isNull(findExact(SLASH_COMMANDS, "xyz"));
    });
  });

  describe("shouldTriggerSlash", function () {
    it("triggers at start of text", function () {
      assert.isTrue(shouldTriggerSlash("/"));
    });
    it("triggers after whitespace", function () {
      assert.isTrue(shouldTriggerSlash("hello /"));
      assert.isTrue(shouldTriggerSlash("a\n/"));
      assert.isTrue(shouldTriggerSlash("a\t/"));
    });
    it("does not trigger mid-word (dates, urls, and/or)", function () {
      assert.isFalse(shouldTriggerSlash("12/3"));
      assert.isFalse(shouldTriggerSlash("https:/"));
      assert.isFalse(shouldTriggerSlash("and/"));
      assert.isFalse(shouldTriggerSlash("ab"));
      assert.isFalse(shouldTriggerSlash(""));
    });
  });
});
