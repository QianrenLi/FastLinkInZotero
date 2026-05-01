import { defineConfig } from "zotero-plugin-scaffold";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import pkg from "./package.json";

const BETTER_NOTES_XPI = join(
  ".scaffold",
  "test",
  "better-notes-for-zotero.xpi",
);
const BETTER_NOTES_ID = "Knowledge4Zotero@windingwind.com";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
    hooks: {
      "test:init": () => {
        const extDir = join(".scaffold", "test", "profile", "extensions");
        if (!existsSync(extDir)) mkdirSync(extDir, { recursive: true });
        if (existsSync(BETTER_NOTES_XPI)) {
          copyFileSync(
            BETTER_NOTES_XPI,
            join(extDir, `${BETTER_NOTES_ID}.xpi`),
          );
        }
      },
    },
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
