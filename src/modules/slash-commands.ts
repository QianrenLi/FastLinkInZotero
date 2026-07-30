// src/modules/slash-commands.ts
// The slash-command registry and the pure predicates that drive trigger
// detection and popup filtering. This module has NO Zotero dependencies so it
// can be unit-tested directly.

export interface SlashTextOutput {
  kind: "text";
  value: string;
}
export interface SlashHtmlOutput {
  kind: "html";
  value: string;
}
/** What a committed shortcut inserts in place of the typed `/word` token. */
export type SlashOutput = SlashTextOutput | SlashHtmlOutput;

export interface SlashCommand {
  /** Word after "/". Lowercase, matches /^[a-z0-9-]+$/. */
  trigger: string;
  /** Shown in the popup row. */
  description: string;
  output: SlashOutput;
}

/**
 * Built-in command registry. To add a shortcut, append an entry: a trigger that
 * is a single continuous word, plus an output (literal text or rich HTML).
 *
 * /todo and /done emit Zotero list-item HTML captured from note.getNote(): an
 * unchecked/checked todo renders as a <ul><li> bullet containing "[ ]" / "[x]"
 * (markdown-style, matching how this Zotero represents todos — not a
 * click-to-toggle widget).
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    trigger: "todo",
    description: "Insert todo item",
    output: {
      kind: "html",
      // Captured from note.getNote() — a Zotero todo list item.
      value: "<ul><li>[ ]</li></ul>",
    },
  },
  {
    trigger: "done",
    description: "Insert checked todo item",
    output: {
      kind: "html",
      value: "<ul><li>[x]</li></ul>",
    },
  },
];

/** True if `s` is a valid continuous shortcut word (no leading slash). */
export function isContinuousWord(s: string): boolean {
  return /^[a-z0-9-]+$/i.test(s);
}

/**
 * Commands whose trigger starts with `word` (case-insensitive prefix match),
 * in registry order. An empty word returns every command.
 */
export function filterByPrefix(
  commands: SlashCommand[],
  word: string,
): SlashCommand[] {
  const w = word.toLowerCase();
  if (!w) return commands.slice();
  return commands.filter((c) => c.trigger.toLowerCase().startsWith(w));
}

/** The command whose trigger exactly equals `word` (case-insensitive), or null. */
export function findExact(
  commands: SlashCommand[],
  word: string,
): SlashCommand | null {
  const w = word.toLowerCase();
  return commands.find((c) => c.trigger.toLowerCase() === w) ?? null;
}

/**
 * Decide whether a newly typed "/" should open the slash popup. True only when
 * `textBeforeCaret` ends with "/" AND that "/" is at the start of the text or
 * immediately preceded by whitespace (space/tab/newline). Guards against dates
 * ("12/30"), URLs, and "and/or".
 */
export function shouldTriggerSlash(textBeforeCaret: string): boolean {
  if (!textBeforeCaret.endsWith("/")) return false;
  if (textBeforeCaret.length === 1) return true; // "/" is the only character
  return /\s/.test(textBeforeCaret[textBeforeCaret.length - 2]);
}
