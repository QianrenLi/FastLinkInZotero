import { assert } from "chai";
import { config } from "../package.json";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("should have the slash command handler initialized", function () {
    // @ts-expect-error - Plugin instance is not typed
    assert.isDefined(Zotero[config.addonInstance].slashCommands);
  });
});
