import { HOST_PERMISSIONS } from "./src/lib/targets";
import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: "src",
  manifest: {
    name: "Clalit Smile – Search by City",
    description:
      "Guarantees the city you searched shows appointments in Clalit dental scheduling, keeping the site's distance-vs-time sort.",
    // No permissions at all — the extension is only content scripts: the city comes from the page's
    // search box, nothing is stored, and there is no background.
    host_permissions: HOST_PERMISSIONS
  },
  vite: () => ({
    build: {
      // Inline source maps only in dev.ts sideload builds; a store `wxt build` ships none.
      sourcemap: process.env.WXT_INLINE_SOURCEMAPS === "1" ? "inline" : false,
      chunkSizeWarningLimit: 4000
    }
  })
});
