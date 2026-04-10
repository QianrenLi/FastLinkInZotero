# FastLinkInZotero

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Obsidian-style note linking with autocomplete popup for Zotero 7.

## Features

- **Inline Autocomplete**: Type `[[` in any note editor to search and link notes
- **Quick Note Creation**: Press `Ctrl+N` to quickly create or reference notes
- **Smart Search**: Exact match, prefix match, and contains match with ranking
- **Native Links**: Uses Zotero's native `zotero://note/` links
- **Independent**: Works without requiring Better Notes plugin

## Usage

### Linking Notes with `[[`

1. While editing a note, type `[[`
2. A popup will appear with note suggestions
3. Type to filter the list
4. Use ↑↓ to navigate, Enter to select
5. The link will be inserted with the note title as display text

### Quick Note Creation with Ctrl+N

1. Press `Ctrl+N` in any note editor
2. Enter a note title or search keywords
3. Select an existing note or create a new one
4. The link will be inserted automatically

## Requirements

- Zotero 7.0 or later

## Installation

### Development Build

```bash
# Clone the repository
git clone https://github.com/yourusername/FastLinkInZotero.git
cd FastLinkInZotero

# Install dependencies
npm install

# Build the plugin
npm run build

# The XPI file will be in .scaffold/build/fast-link-in-zotero.xpi
```

### Install in Zotero

1. Download the latest `.xpi` file from [Releases](https://github.com/yourusername/FastLinkInZotero/releases)
2. In Zotero, go to Tools → Add-ons
3. Click the gear icon → Install Add-on From File
4. Select the downloaded `.xpi` file

## Development

```bash
# Install dependencies
npm install

# Start development mode with hot reload
npm start

# Build for production
npm run build

# Release
npm run release
```

## License

[AGPL-3.0-or-later](LICENSE)

## Credits

Built with [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template)
