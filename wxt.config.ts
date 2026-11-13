import { defineConfig } from "wxt";

import { HOST_PERMISSIONS } from "./src/lib/targets";

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-svelte"],
  svelte: {
    vite: {
      // Inline component CSS into the JS (Svelte's append_styles is shadow-root-aware) instead of
      // emitting a CSS file the content script would fetch via browser.runtime.getURL - the dev loop
      // re-injects bundles into MAIN-world contexts that have no chrome.* APIs at all.
      compilerOptions: {
        css: "injected"
      }
    }
  },
  manifest: {
    // Hebrew, because every screen it appears on is: the site, the rows it writes, the badge.
    name: "כללית סמייל - חיפוש לפי עיר",
    description: "מבטיח שכל סניפי כללית סמייל בעיר שחיפשתם מופיעים בזימון התורים, עם המרחק ממיקומכם הנוכחי.",
    // The only two permissions, in dev and in a store build alike, and both serve one feature:
    // "distance from where you are" is the extension's own reading, not the site's. `geolocation` is
    // that reading; `offscreen` is the only context allowed to take it (a service worker cannot).
    // Nothing is stored, and the city still comes from the page's own search box. The dev loop needs
    // no permission of its own - it drives everything over CDP (scripts/dev-shared.ts).
    permissions: ["geolocation", "offscreen"],
    host_permissions: HOST_PERMISSIONS,
    author: {
      email: "avi6106@gmail.com"
    },
    homepage_url: "https://avi12.com"
  },
  zip: {
    artifactTemplate: "clalit-smile-search-by-city-{{version}}-{{browser}}.zip",
    excludeSources: ["user-profiles/**", ".dev-logs/**", ".output/**", ".wxt/**", "keys/**", "scripts/**"]
  },
  vite: () => ({
    plugins: [
      {
        name: "ignore-locked-profile-dirs",
        // The cloned dev-Chrome profile holds OS-locked SQLite files (Cookies etc.) while the dev
        // browser runs, and the vite-node server behind `wxt prepare` watches the whole project root,
        // crashing on them with EBUSY. WXT hard-overwrites inline `server.watch`, so the ignores must
        // come from a plugin config hook - merged (arrays concatenate) after WXT builds its config.
        config() {
          return {
            server: {
              watch: {
                ignored: ["**/user-profiles/**", "**/.dev-logs/**"]
              }
            }
          };
        }
      }
    ],
    build: {
      // Inline source maps only in dev.ts sideload builds; a store `wxt build` ships none.
      sourcemap: process.env.WXT_INLINE_SOURCEMAPS === "1" ? "inline" : false,
      chunkSizeWarningLimit: 4000
    }
  })
});
