import { HOST_PERMISSIONS } from "./src/lib/targets";
import { defineConfig } from "wxt";

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
    name: "Clalit Smile - Search by City",
    description:
      "Guarantees the city you searched shows appointments in Clalit dental scheduling, keeping the site's distance-vs-time sort.",
    // The only two permissions, and both serve one feature: "distance from where you are" is the
    // extension's own reading, not the site's. `geolocation` is that reading; `offscreen` is the only
    // context allowed to take it (a service worker cannot). Nothing is stored, and the city still comes
    // from the page's own search box.
    permissions: ["geolocation", "offscreen"],
    host_permissions: HOST_PERMISSIONS
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
