# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FastLinkInZotero is a Zotero 7 plugin that provides Obsidian-style `[[note linking]]` with an autocomplete popup. It consists of two main features:

- **NoteLinkAutocomplete**: Triggers on `[[` to show a searchable popup of notes
- **QuickCreateHandler**: Triggered by `Ctrl+N` to quickly create or link notes

## Development Commands

```bash
nvm use 22    # Use Node.js 22 (required)
npm start     # Start development server with hot reload
npm run build # Build production XPI
npm run test  # Run tests via zotero-plugin test framework
npm run lint:check   # Check linting and formatting
npm run lint:fix     # Fix linting and formatting issues
npm run release      # Build and package for release
```

## Architecture

### Source Structure

- `src/index.ts` - Entry point; initializes the global `addon` instance and ztoolkit
- `src/addon.ts` - Addon class; holds plugin state (data, hooks, api)
- `src/hooks.ts` - Zotero lifecycle hooks (onStartup, onShutdown, etc.); registers NoteLinkAutocomplete, QuickCreateHandler, and keyboard shortcuts
- `src/modules/` - Feature modules:
  - `note-link-autocomplete.ts` - Handles `[[` trigger, popup display, and selection
  - `quick-create-handler.ts` - Handles Ctrl+N quick note creation
  - `note-search-service.ts` - Builds in-memory note cache and provides search (exact/prefix/contains matching)
  - `popup-controller.ts` - Manages the autocomplete popup UI
  - `link-inserter.ts` - Inserts `zotero://note/` links into editors
- `src/utils/` - Utilities for ztoolkit, editor detection, locale, prefs
- `addon/` - Static addon resources (manifest, FTL locale files, icons, prefs)

### Build Process

The plugin uses [zotero-plugin-scaffold](https://github.com/windingwind/zotero-plugin-template). Config is in `zotero-plugin.config.ts`. Source TypeScript is bundled via esbuild into `.scaffold/build/addon/content/scripts/`.

### Testing

Tests run in a Zotero instance via `zotero-plugin test`. The test in `test/startup.test.ts` verifies the plugin instance is registered. Tests wait for `Zotero.FastLink.data.initialized` before running.

## Zotero API Notes

- The plugin registers itself as `Zotero.FastLink` (from `addonInstance` in package.json config)
- Zotero events are observed via `Zotero.Notifier.registerObserver` for cache invalidation
- Keyboard shortcuts are registered via `ztoolkit.Keyboard.register`
- Note editors are accessed via `ZoteroContextPane.activeEditor` (reader mode) or `ZoteroPane.itemPane._noteEditor` (standalone mode)
- Links use Zotero's native `zotero://note/<noteID>/` URI scheme

## Debugging

### Log Output

- **Zotero Error Console**: `Zotero.debug()` output appears at `Tools → Developer → Error Console`
- **File Logging**: The plugin can write logs to `%PROFILE%/fastlink-debug.log` via `fileLog()` in `src/utils/file-logger.ts`

### Debug Log Location

On Windows, the Zotero profile directory is typically at:

```
%APPDATA%\Zotero\Zotero\Profiles\<profile-id>\
```

To find your profile path, open Zotero and go to `Edit → Preferences → Advanced → Config Editor`, then search for `profileDir`.

### Enabling Debug Logging

Add `fileLog()` calls to trace execution flow. The log file is written asynchronously and persists across sessions.

### Testing

Tests run in a Zotero instance via `zotero-plugin test`. The test in `test/startup.test.ts` verifies the plugin instance is registered. Tests wait for `Zotero.FastLink.data.initialized` before running.

**Automated test procedure (follow this exactly):**
```bash
# 1. Kill leftover Zotero processes first
taskkill //f //im zotero.exe 2>/dev/null
rm -f .scaffold/test/profile/lock .scaffold/test/profile/.parentlock 2>/dev/null

# 2. Run tests in background, monitoring for completion
ZOTERO_PLUGIN_ZOTERO_BIN_PATH="/c/Users/qianrenli2/scoop/apps/zotero/current/zotero.exe" \
  npm run test > /tmp/test_output.txt 2>&1 &
TEST_PID=$!

# 3. Monitor until "Test run completed" appears, then auto-kill Zotero
while kill -0 $TEST_PID 2>/dev/null; do
  if grep -q "Test run completed" /tmp/test_output.txt 2>/dev/null; then
    sleep 2
    taskkill //f //im zotero.exe 2>/dev/null
    break
  fi
  sleep 3
done

# 4. Print results
cat /tmp/test_output.txt
```