// src/utils/file-logger.ts
// Captures all [FastLink] debug messages and flushes to file automatically.
// Uses Zotero.File.putContentsAsync (proven to work in Zotero 7).

const MAX_BUFFER_SIZE = 5000;

let originalDebug: ((message: any, level?: number) => void) | null = null;
const logBuffer: string[] = [];
let flushTimer: any = null;
let logFilePath: string | null = null;
let appendOffset = 0; // track file size to avoid re-reading

function getLogFilePath(): string {
  if (!logFilePath) {
    logFilePath = OS.Path.join(
      Zotero.getTempDirectory().path,
      "fastlink-debug.log",
    );
  }
  return logFilePath;
}

async function writeAppend(content: string): Promise<boolean> {
  try {
    const FileUtils: any = ChromeUtils.import(
      "resource://gre/modules/FileUtils.jsm",
      {},
    ).FileUtils;
    const file = new FileUtils.File(getLogFilePath());

    if (appendOffset === 0) {
      // First write — create/overwrite
      await Zotero.File.putContentsAsync(file, content);
      appendOffset = content.length;
    } else {
      // Append — read existing, append new content
      // (Zotero 7 doesn't expose a direct append API)
      const existing = await Zotero.File.getContentsAsync(file);
      const combined = (typeof existing === "string" ? existing : "") + content;
      await Zotero.File.putContentsAsync(file, combined);
      appendOffset = combined.length;
    }
    return true;
  } catch (_e) {
    return false;
  }
}

function startAutoFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (logBuffer.length === 0) return;
    const lines = logBuffer.splice(0);
    void writeAppend(lines.join("\n") + "\n").then((ok) => {
      if (!ok) {
        // Re-add failed lines (respecting buffer limit)
        const toReadd = lines.slice(-(MAX_BUFFER_SIZE - logBuffer.length));
        logBuffer.unshift(...toReadd);
      }
    });
  }, 1000);
}

export async function setupFileLogging(): Promise<void> {
  if (originalDebug) return;

  // Monkey-patch Zotero.debug to capture [FastLink] messages
  const target = Zotero as any;
  originalDebug = target.debug.bind(Zotero);
  target.debug = function (message: any, level?: number) {
    (originalDebug as any)(message, level);
    if (typeof message === "string" && message.startsWith("[FastLink]")) {
      if (logBuffer.length < MAX_BUFFER_SIZE) {
        logBuffer.push(`[${new Date().toISOString()}] ${message}`);
      }
    }
  };

  logBuffer.push(`[${new Date().toISOString()}] [FastLink] Log system started`);
  appendOffset = 0;
  startAutoFlush();
}

export function teardownFileLogging(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (logBuffer.length > 0) {
    const lines = logBuffer.splice(0);
    void writeAppend(lines.join("\n") + "\n");
  }
  if (originalDebug) {
    (Zotero as any).debug = originalDebug;
    originalDebug = null;
  }
}

export function getLogContent(): string {
  return logBuffer.join("\n");
}
export function getLogCount(): number {
  return logBuffer.length;
}
export function clearLogBuffer(): void {
  logBuffer.length = 0;
}

export async function flushLogToFile(): Promise<boolean> {
  if (logBuffer.length === 0) return false;
  const lines = logBuffer.splice(0);
  const ok = await writeAppend(lines.join("\n") + "\n");
  if (!ok) {
    const toReadd = lines.slice(-(MAX_BUFFER_SIZE - logBuffer.length));
    logBuffer.unshift(...toReadd);
  }
  return ok;
}
