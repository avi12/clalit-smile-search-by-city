# Clalit Smile - Search by City

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Chrome extension (WXT) for the Clalit Smile hygienist (שיננית) booking flow: **search a city, get
that city - all of it, only it** - and make the distance sort mean **distance from you**.

Clalit Smile hygienist booking actually runs on Clalit's **Tamuz** scheduler at
`e-services.clalit.co.il` (behind login, inside an iframe) - see
[`docs/reverse-engineering.md`](docs/reverse-engineering.md) for the full teardown of how the system
is put together and exactly where the extension hooks in.

## Before / after

**Before** - the site's own "מרפאות מאזור היישוב" search for בת ים. The header says **באזור** (in the
_area_), 21 results, and the list mixes in clinics from other cities - חולון here. Each row measures
**"מרחק מהבית שלך"**: the distance from your registered home address, wherever you happen to be.

![The unmodified Clalit Smile results for Bat Yam: 21 results "in the area", with Holon clinics in the list and distances measured from your registered home address](assets/before.png)

**After** - the same city with the extension on. The header says **בעיר** (in the _city_), every row is
בת ים, and the badge in the corner names the guarded city with its count (**3/89** - three in the city out
of the 89 the rewritten all-country search returned). Distances are now **"מרחק ממיקומך"**, measured from
where you actually are, and the red **לכל התורים** marks a branch that has no online slot for the service
you searched.

![The same city with the extension on: 3 results "in the city", all Bat Yam, distances from your live position, a red button on the branch with no online slot, and the status badge reading 3/89](assets/after.png)

> The two shots are different services (שיננית before, בדיקת רופא after) - what they show is the shape of
> the change: area → city, other cities gone, home-distance → live distance.

## What you get

Three guarantees, applied live to the site's own results:

1. **Only the searched city - and ALL of it.** Tamuz's "area" search returns a subset of the city's
   clinics, and it skips any branch without a currently bookable diary. The extension searches the
   **whole country** under the hood, filters each response down to your city, aggregates every server
   page into one list, and appends the city's remaining branches (the ones with no bookable diary)
   from a committed clinic directory - so nothing in the city is missed.
2. **Distance means distance from YOU.** When you pick the distance sort, the list is re-ranked by
   your live position (`navigator.geolocation` → great-circle distance against committed clinic
   coordinates) and relabelled **"מרחק ממיקומך"** - not distance from the searched city, not from
   your registered home address. If you deny the location prompt, the site's own order stays.
3. **The site's order is respected.** Filtering and aggregation preserve the server's row order;
   the extension never re-sorts - except for the live-distance re-rank above, which you opted into
   by choosing the distance sort.

An in-page **status badge** shows the guarded city and the in-city count, with a session on/off
toggle. The city itself is whatever you type into the **site's own search box** - nothing to
configure, nothing stored.

## Install

Not on the Chrome Web Store - grab the `.crx` or the `.zip` from
[**Releases**](https://github.com/avi12/clalit-smile-search-by-city/releases/latest), then:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Drag the downloaded file onto the page.** Either one installs - no unzipping.

Then open Clalit's appointment booking, go to **כללית סמייל**, and search a city as usual. Chrome will
ask for location the first time the distance sort runs - decline it and everything else still works, the
list just keeps the site's own order.

## How it works

MV3 content scripts do all the work, with **no storage and nothing persisted**. The only permissions
are `geolocation` + `offscreen`, and they serve one feature between them: the position is read in the
EXTENSION's own offscreen document, so it never depends on what the site was granted.

- **MAIN-world interceptor** ([`clalit-interceptor.content/`](src/entrypoints/clalit-interceptor.content))
  patches `fetch`/`XMLHttpRequest` at `document_start` in **all frames** (the booking UI is an
  iframe). The Smile search responses are **server-rendered HTML fragments inside a JSON envelope**;
  the interceptor rewrites the outgoing search from "area" to "all country", filters each fragment to
  the city ([`smile.ts`](src/entrypoints/clalit-interceptor.content/smile.ts)), fetches the remaining
  server pages, and applies the live-distance re-rank ([`geo.ts`](src/lib/geo.ts)).
- **ISOLATED bridge** ([`clalit-bridge.content/`](src/entrypoints/clalit-bridge.content)) reads
  the city from the page's search box, renders the status badge in the top frame, and shares state
  with the tab's other frames.
- The two talk over a **window channel** (`@webext-core/messaging/page`); the bridges of a tab talk to
  each other over a **BroadcastChannel** named for that tab
  ([`messaging-frames.ts`](src/entrypoints/clalit-bridge.content/messaging-frames.ts)). **Every
  external input** - channel payloads, frame broadcasts, the network envelope - is validated with
  **zod** at the boundary, in the `schemas.ts` of whichever entrypoint _receives_ it; malformed input
  is ignored, never thrown on.

An entrypoint that owns private modules is a folder holding them; one that owns none is a single
file. `lib/` keeps only what genuinely crosses an entrypoint, and the dependency runs one way -
nothing in `lib/` imports from an entrypoint.

```
src/
  entrypoints/
    clalit-interceptor.content/  # MAIN world: patch fetch/XHR, rewrite/filter/aggregate, live-distance rank
      index.ts                   # the patches and the wiring; each behaviour is its own module beside it
      smile.ts                   # the city guarantee over the HTML-fragment envelope (order-preserving)
      smile-session.ts / smile-aggregation.ts / smile-availability.ts / smile-row-actions.ts
      live-distance.ts / clinic-directory.ts   # GENERATED coords (from nearme c.json) + the ranking
      site-chrome.ts / phone-links.ts / transform.ts / text.ts / schemas.ts
    clalit-bridge.content/       # ISOLATED: read the search box, feed MAIN, badge + the tab's frame channel
      index.ts
      messaging-frames.ts        # the BroadcastChannel - only an ISOLATED world can open one
      status-badge.svelte.ts / StatusBadge.svelte / schemas.ts
    background.ts / offscreen/   # one job: read the position under the EXTENSION's own permission
  lib/                     # reached by three entrypoints or more - and nothing else
    targets.ts             # SSOT: hosts, search-box selectors, Smile endpoint paths
    messaging.ts           # the contracts for all three channels
    messaging-page.ts / messaging-runtime.ts   # the two transports more than one entrypoint speaks
    geo.ts                 # great-circle distance + the LatLng the channels carry
scripts/                   # dev launcher (cloned-profile Chrome) + clinic-directory generator
docs/reverse-engineering.md
```

## Clinic data

Coordinates and the full branch list come from Clalit's **public** clinic directory at
`nearme.clalit.co.il/c.json` - the same dataset behind each result row's "הצגת מפה" map link:

```bash
pnpm clinics:fetch   # regenerates src/entrypoints/clalit-interceptor.content/clinic-directory.ts
```

The generated file is committed, so the data is **baked into the build**: no runtime network calls,
no extra permissions. Re-run when Clalit opens or moves clinics.

## Privacy

Everything happens inside your browser, on the page you're already on. **No data leaves the
browser** - there is no server, no analytics, no storage. Geolocation is read only when you choose
the distance sort, and only to rank the already-fetched results locally.

## Dev & build

```bash
pnpm install
pnpm ext:dev      # dev loop (see below)
pnpm ext:build    # production build
pnpm ext:zip      # store-ready zip
pnpm release      # build + zip + a signed .crx (see below)
pnpm lint         # oxlint + eslint
pnpm typecheck    # tsc --noEmit
```

`pnpm ext:dev` launches Chrome against a **clone of your real profile** (so your Clalit login
carries over) with the extension sideloaded and a **fixed CDP port** exposed for devtools tooling.
On save it **re-injects the rebuilt content scripts into the live page without reloading** - a
reload would reset the Tamuz SPA to its home screen and lose your search - with the superseded
generation standing down cleanly.

For the full story of how the booking system was mapped (the login wall, the HTML-fragment API, the
session-bound paging, the dry-run of the booking chain), read
[`docs/reverse-engineering.md`](docs/reverse-engineering.md).

### Releasing

`pnpm release` builds, zips, and packs a `.crx` with **Chrome itself** (`--pack-extension`). The signing
key is the extension's identity - the same key must sign every release, or the CRX installs as a
different extension - so it lives outside the repo (`keys/` is gitignored) at the path in
`CHROME_CRX_PRIVATE_KEY_PATH` (see [`.env.example`](.env.example)). The first run generates one there;
keep it and back it up.

## Contributing

Issues and PRs are welcome. Two things the codebase is strict about, both worth reading before a PR:

- `pnpm lint` **and** `pnpm typecheck` must pass - that is the gate.
- [`CLAUDE.md`](CLAUDE.md) is the working spec: architecture, the SSOT rules, naming, and the gotchas
  that are load-bearing (MAIN vs ISOLATED world, the server-session-bound search, Hebrew city matching).
  It is written for an AI pair-programmer but it is the honest description of how this repo works.

If Clalit changes something, update [`docs/reverse-engineering.md`](docs/reverse-engineering.md) in the
same change - findings **and** the method that captured them.

## Author

**Avi** - [avi12.com](https://avi12.com) · [avi6106@gmail.com](mailto:avi6106@gmail.com)

## License

[MIT](LICENSE)

Not affiliated with, endorsed by, or connected to Clalit Health Services. "Clalit", "Clalit Smile" and
"Tamuz" belong to their respective owners. The extension only reshapes pages you are already logged into,
in your own browser.
