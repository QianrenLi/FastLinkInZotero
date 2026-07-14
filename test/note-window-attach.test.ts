import { assert } from "chai";
import {
  getEditorWindow,
  getIframeByWindow,
} from "../src/utils/editor-detector";

/**
 * Diagnostic test for the multi-window fix. Decouples "did a new window open",
 * "did attachToWindow run for it", and "what editor element does that window
 * contain" so a failure pinpoints which assumption is wrong.
 */
describe("note window autocomplete attach", function () {
  this.timeout(60000);

  it("attaches `[[` listeners to a note opened in a new window", async function () {
    const addon = (Zotero as any).FastLink;
    assert.isOk(addon, "Zotero.FastLink addon instance exists");
    const autocomplete = (addon as any).autocomplete;
    assert.isOk(autocomplete, "autocomplete instance is exposed on the addon");

    // Complete window enumeration via the window mediator (getWindows/
    // getMainWindows miss some window types such as reader windows).
    const getWins = (): Window[] => {
      try {
        const wm = (Services as any).wm;
        if (wm?.getEnumerator) {
          const out: Window[] = [];
          const e = wm.getEnumerator(null);
          while (e.hasMoreElements()) out.push(e.getNext() as Window);
          return out;
        }
      } catch {
        /* ignore */
      }
      return ((Zotero as any).getWindows?.() ??
        Zotero.getMainWindows()) as Window[];
    };
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const attachedBefore = autocomplete.getAttachedWindows().length;
    const winsBefore = getWins().length;
    assert.isAtLeast(
      attachedBefore,
      1,
      "at least the main window is attached after init",
    );

    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.setNote("<h1>Window attach test</h1><p>type here</p>");
    await note.saveTx();

    Zotero.getActiveZoteroPane().openNote(note.id, { openInWindow: true });

    // Poll for any change (new window OR new attached window).
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (
        autocomplete.getAttachedWindows().length > attachedBefore ||
        getWins().length > winsBefore
      ) {
        break;
      }
      await wait(300);
    }
    // Allow onMainWindowLoad (async) + the 100ms iframe debounce to settle.
    await wait(1500);

    const attachedAfter = autocomplete.getAttachedWindows().length;
    const winsAfter = getWins().length;

    // Build a diagnostic dump of every window's editor-relevant tags.
    const lines: string[] = [
      `attached windows: ${attachedBefore} -> ${attachedAfter}`,
      `all windows:      ${winsBefore} -> ${winsAfter}`,
    ];
    for (const w of getWins()) {
      try {
        const doc = (w as any).document;
        const uri =
          doc?.documentURI ?? doc?.documentElement?.id ?? doc?.URL ?? "?";
        const allTags = Array.from(
          doc?.querySelectorAll("*") ?? [],
        ) as Element[];
        const relevant = [
          ...new Set(
            allTags
              .map((e) => e.tagName.toLowerCase())
              .filter(
                (t) =>
                  t.includes("note") ||
                  t.includes("reader") ||
                  t.includes("editor"),
              ),
          ),
        ];
        lines.push(
          `- uri=${uri} attached=${autocomplete
            .getAttachedWindows()
            .includes(w)} tags=[${relevant.join(", ")}]`,
        );
      } catch (e) {
        lines.push(`- window inspect error: ${e}`);
      }
    }
    const report = lines.join("\n");
    Zotero.debug(`[FastLink-test]\n${report}`);

    try {
      assert.isAbove(
        winsAfter,
        winsBefore,
        `openNote did not open a new window.\n${report}`,
      );
      assert.isAbove(
        attachedAfter,
        attachedBefore,
        `attachToWindow did NOT run for the note window — neither ` +
          `onMainWindowLoad nor the window watcher fired for it.\n${report}`,
      );

      // The note window must be attached and its editor must resolve the note
      // (handleSelection depends on <note-editor>.item to know the source note).
      const noteWin = getWins().find(
        (w) =>
          (w as any).document?.documentURI?.includes("note.xhtml") &&
          autocomplete.getAttachedWindows().includes(w),
      );
      assert.isOk(noteWin, `note.xhtml window is attached.\n${report}`);

      const noteEditorEl = (noteWin as any).document.querySelector(
        "note-editor",
      ) as any;
      const itemDeadline = Date.now() + 15000;
      let itemResolved = false;
      while (Date.now() < itemDeadline) {
        if (noteEditorEl?.item?.isNote?.()) {
          itemResolved = true;
          break;
        }
        await wait(200);
      }
      assert.isTrue(
        itemResolved,
        `<note-editor>.item did not resolve to the note.\n${report}`,
      );

      // Editor-iframe resolution is the root cause of the positioning and
      // source-note bugs in note windows: getIframeByWindow must find the
      // note editor iframe (it scans getAllWindows, which must include
      // note.xhtml via Services.wm).
      const editorIframeWin = getEditorWindow(noteWin as any) as Window | null;
      assert.isOk(editorIframeWin, `editor iframe resolved.\n${report}`);
      const iframeMatch = editorIframeWin
        ? getIframeByWindow(editorIframeWin)
        : null;
      assert.isOk(
        iframeMatch,
        `getIframeByWindow did NOT find the note editor iframe — positioning ` +
          `and source-note resolution will fail in note windows.\n${report}`,
      );
      assert.strictEqual(
        iframeMatch?.hostWindow,
        noteWin,
        `iframe host is not the note window.\n${report}`,
      );
    } finally {
      // Cleanup (best effort); profile is disposable regardless.
      try {
        for (const w of getWins()) {
          if (
            w !== Zotero.getMainWindow() &&
            (w as any).document?.querySelector?.("note-editor")
          ) {
            (w as Window).close?.();
          }
        }
      } catch {
        /* ignore */
      }
      try {
        await note.eraseTx();
      } catch {
        /* ignore */
      }
    }
  });
});
