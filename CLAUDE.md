# Project
A WXT MV3 Chrome extension that guarantees a searched city in Clalit's "Tamuz" / Clalit Smile hygienist (שיננית) booking flow shows ONLY that city and ALL of its branches, and that a "distance" sort uses the user's live `navigator.geolocation`. Pure content scripts - no background, no storage, no permissions beyond `host_permissions`.
- The booking UI is an iframe on `e-services.clalit.co.il` (behind login); `clalitsmile.co.il` is only the marketing site. Full teardown in `docs/reverse-engineering.md` - read it before touching the interceptor, `smile.ts` or `targets.ts`.
- Mechanism: patch `fetch`/`XMLHttpRequest` in the page's MAIN world (`document_start`, all frames) and rewrite the server responses - which are a JSON envelope `{ data }` wrapping a SERVER-RENDERED HTML fragment (`li.diary` rows), not JSON data.

# Stack
- pnpm
- WXT extension framework, plain TypeScript content scripts (no UI framework - the badge is a hand-built shadow-DOM widget)
- TypeScript (100% type safety, let TypeScript infer return types - never write them explicitly)
- zod for every external input (`src/lib/schemas.ts`)
- @webext-core/messaging - only the window channel (`/page`, `src/lib/messaging-page.ts`); no runtime (chrome) messaging exists
- oxlint (type-aware, logic rules) + ESLint (stylistic + local rules); dev tooling runs via tsx (Node, never Bun - web-ext-run depends on Node's child_process socket handling)

# Architecture
Two content scripts, both `allFrames` (the booking UI is an iframe):
- `src/entrypoints/clalit-interceptor.content.ts` - MAIN world: patches fetch/XHR, rewrites the outgoing search (area → all-country, `sortValue=4` → `3`), filters responses to the city, aggregates the remaining server pages, appends no-diary branches, re-ranks by live location, and opens the site's clinic-details lightbox for no-GUID branches (fragment recomposed from the committed directory, shown via the page's own `z.showDialog`)
- `src/entrypoints/clalit-bridge.content.ts` - ISOLATED world: reads the city from the site's search box, pushes config to MAIN over the window channel, renders the status badge (top frame only; child frames relay state up via `postMessage`)

Key lib modules:
- `targets.ts` - SSOT for hosts, matches/`host_permissions`, search-box selectors, guarantee mode, Smile endpoint paths, endpoint rules. Imported by both runtime and `wxt.config.ts`
- `smile.ts` - the HTML-fragment guarantee (pure string→string); `transform.ts` - the generic JSON guarantee (heuristic/rule-based)
- `schemas.ts` - zod schemas for every external input (call `schema.safeParse()` at the boundary); `messaging.ts`/`messaging-page.ts` - the window channel contracts
- `geo.ts` (haversine) + `clinic-directory.ts` - GENERATED from Clalit's public `nearme.clalit.co.il/c.json` by `pnpm clinics:fetch`; never hand-edit (ESLint ignores it). `clinics.ts` is a different code space (marketing-site 9xxx codes), reference only
- `dev-takeover.ts` - dev-only generation handoff; `status-badge.ts` - pure UI

# Engineering conventions
- SSOT / DRY - every fact has one authoritative home and everything else reads from it: hosts/selectors/endpoints live only in `targets.ts`, message shapes only in `messaging.ts` + `schemas.ts`, coordinates only in `clinic-directory.ts`. Never re-derive or duplicate a value another module already owns
- MAIN vs ISOLATED split is load-bearing: the MAIN world can patch the page's `fetch`/XHR but has NO `chrome.*` access; the ISOLATED world has extension APIs but cannot patch page globals. They talk only over the window channel. Anything imported by the interceptor must stay chrome-free and dependency-light
- The city comes from the SITE'S SEARCH BOX (and the submitted search request body), never from storage or config. There is nothing to configure and nothing persisted; the on/off toggle is session-only
- Transforms are order-preserving: the server already sorted by the user's chosen distance-vs-time option, so filter/append without re-sorting. The ONE deliberate exception is the live-location re-rank when the home-distance sort is active (stable sort, unknown-coordinate rows keep server order at the end)
- zod at every trust boundary: window-channel payloads, the forgeable frame-relay and dev-takeover `postMessage`s, and the network envelope all go through `schemas.ts` at the edge; parse with `schema.safeParse()` and ignore a malformed value (`{ success: false }`), never throw on it. Inner code works only with validated shapes
- Message passing goes through **@webext-core/messaging**. The bridge ⇄ MAIN state channel uses its window messaging (`/page`, `messaging-page.ts`) with contracts in `messaging.ts` - never hand-roll `chrome.runtime` or ad-hoc `postMessage` for it. Only two narrow channels use raw `window.postMessage`, because the library's window channel is same-window request/response and there is NO background to relay through: (1) the cross-FRAME relay (child iframe ⇄ top frame, driving the single top badge) and (2) the dev-only takeover broadcast (fire-and-forget to all coexisting generations). Both are zod-validated on receipt. Do not add a third ad-hoc channel - extend the window channel or justify a new documented exception
- No permission creep: no `permissions`, no background, no storage. `host_permissions` is derived from `CONTENT_MATCHES` so access can never drift. Live-location ranking works off the COMMITTED directory - zero runtime network beyond the page's own session calls
- Gate: `pnpm lint` AND `pnpm typecheck` must both pass after every change. `pnpm lint` runs oxlint --fix (relaxed `.oxlintrc.fix.json`) → eslint --fix (strips dead imports) → plain oxlint as the final check

# Code style
- Function declarations, not arrow-consts (`func-style`); early returns; `for-of` over `.forEach`
- No comments unless necessary - descriptive names first; no em dashes, use hyphens
- No type assertions (`consistent-type-assertions: never`), no `any`, no `@ts-` comments
- Content-script code never reads `process` - Node globals exist only in `scripts/` and config files
- Double quotes, 2-space indent, 120-char lines - ESLint enforces the rest, don't fight it

# Dev workflow
`pnpm ext:dev` (tsx `scripts/dev.ts`) is the whole loop:
- Builds the dev bundle (inline source maps), clones your real Chrome profile into `user-profiles/chrome` (carries your Clalit login, fully decoupled from the real session), launches Chrome via web-ext-run with a FIXED CDP port `9223` (`CDP_PORT` in `scripts/dev-chrome.ts`; `.mcp.json` mirrors it manually - update both if it ever changes). chrome-devtools-mcp attaches with `--browser-url http://127.0.0.1:9223`
- On a `src/` change it rebuilds and RE-INJECTS the fresh content-script bundles into the live Clalit frames over CDP - it does NOT reload the tab, because a reload resets the Tamuz booking SPA to its home screen and loses the search state. The dev-takeover channel (`src/lib/dev-takeover.ts`) makes each superseded generation stand down (remove its UI, become a pass-through) when a newer one announces itself
- `wxt.config.ts` / `.env` changes DO reload the open tabs (they reshape the manifest); a manifest change may still need a manual reload from `chrome://extensions`
- Dev logs: `.dev-logs/dev.log`. Dev builds also log interesting requests to the PAGE console (`[clalit-city] …`) - that is the discovery mode for filling in `ENDPOINT_RULES`
- `pnpm ext:build` / `pnpm ext:zip` for production (no source maps, no dev-takeover code); `pnpm clinics:fetch` regenerates `clinic-directory.ts` when Clalit opens/moves clinics

# Reverse-engineering log - REQUIRED
Whenever you reverse-engineer ANYTHING about Clalit's systems - an API endpoint, a request/response shape, a data set, a site behavior, an auth quirk - you MUST record both the findings and the method in `docs/reverse-engineering.md` in the same change. This is a standing instruction, not optional polish: the knowledge there (which endpoints exist, exact request fields and response envelopes, how each was captured - curl probe, `__NEXT_DATA__` parse, logged-in CDP session - and the capture date) is what makes the extension maintainable when Clalit changes something, and anything left only in a chat or a scratchpad is lost. Update the existing sections when a shape changes; add a dated section for new discoveries. Read that doc BEFORE probing - most questions are already answered there.

# Gotchas
- The Smile result set is SERVER-SESSION state: sort and `Paging` operate on the session's last search, and each row's diary GUID is valid only for that search. Never splice rows from a second search into the list - that's why the guarantee rewrites the ONE outgoing search to all-country and then filters/aggregates its own responses. Dedup rows by clinic name, not GUID
- The "area" search (`IsShowClinicsFromAreaCity=1`) is a SUBSET that can miss the city's own clinics, and Tamuz omits branches with no bookable diary entirely - hence the all-country rewrite plus synthetic rows from `SMILE_BRANCHES`
- XHR patching subtleties (see interceptor comments before touching): response getters are defined per-instance from `send()`, not `open()`, so stacked dev generations don't clobber the active one; `responseText` throws for `responseType: "json"` - read `response` instead
- When rebuilding a transformed `fetch` Response, drop `content-encoding`/`content-length` - the body is already-decoded JSON and stale headers corrupt the page's read
- City matching is Hebrew-tolerant via `normalizeCity` (geresh/quote/whitespace normalization) with bidirectional substring match - reuse it, don't compare raw strings
