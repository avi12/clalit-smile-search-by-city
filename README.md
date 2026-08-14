# Clalit Smile – Search by City

A Chrome extension (WXT) for the Clalit Smile hygienist (שיננית) booking flow: **search a city, get
that city — all of it, only it** — and make the distance sort mean **distance from you**.

Clalit Smile hygienist booking actually runs on Clalit's **Tamuz** scheduler at
`e-services.clalit.co.il` (behind login, inside an iframe) — see
[`docs/reverse-engineering.md`](docs/reverse-engineering.md) for the full teardown of how the system
is put together and exactly where the extension hooks in.

## What you get

Three guarantees, applied live to the site's own results:

1. **Only the searched city — and ALL of it.** Tamuz's "area" search returns a subset of the city's
   clinics, and it skips any branch without a currently bookable diary. The extension searches the
   **whole country** under the hood, filters each response down to your city, aggregates every server
   page into one list, and appends the city's remaining branches (the ones with no bookable diary)
   from a committed clinic directory — so nothing in the city is missed.
2. **Distance means distance from YOU.** When you pick the distance sort, the list is re-ranked by
   your live position (`navigator.geolocation` → great-circle distance against committed clinic
   coordinates) and relabelled **"מרחק ממיקומך"** — not distance from the searched city, not from
   your registered home address. If you deny the location prompt, the site's own order stays.
3. **The site's order is respected.** Filtering and aggregation preserve the server's row order;
   the extension never re-sorts — except for the live-distance re-rank above, which you opted into
   by choosing the distance sort.

An in-page **status badge** shows the guarded city and the in-city count, with a session on/off
toggle. The city itself is whatever you type into the **site's own search box** — nothing to
configure, nothing stored.

## How it works

Pure MV3 content scripts — **no background, no storage, no permissions beyond host access to the two
Clalit sites**:

- **MAIN-world interceptor** ([`clalit-interceptor.content.ts`](src/entrypoints/clalit-interceptor.content.ts))
  patches `fetch`/`XMLHttpRequest` at `document_start` in **all frames** (the booking UI is an
  iframe). The Smile search responses are **server-rendered HTML fragments inside a JSON envelope**;
  the interceptor rewrites the outgoing search from "area" to "all country", filters each fragment to
  the city ([`smile.ts`](src/lib/smile.ts)), fetches the remaining server pages, and applies the
  live-distance re-rank ([`geo.ts`](src/lib/geo.ts)).
- **ISOLATED bridge** ([`clalit-bridge.content.ts`](src/entrypoints/clalit-bridge.content.ts)) reads
  the city from the page's search box, renders the status badge in the top frame, and relays state
  between frames.
- The two talk over a **window channel** (`@webext-core/messaging/page`), and **every external
  input** — channel payloads, frame-relay messages, the network envelope — is validated with **zod**
  at the boundary ([`schemas.ts`](src/lib/schemas.ts)); malformed input is ignored, never thrown on.

```
src/
  entrypoints/
    clalit-interceptor.content.ts  # MAIN world: patch fetch/XHR, rewrite/filter/aggregate, live-distance rank
    clalit-bridge.content.ts       # ISOLATED: read the search box, feed MAIN, badge + frame relay
  lib/
    targets.ts             # SSOT: hosts, search-box selectors, Smile endpoint paths
    smile.ts               # the city guarantee over the HTML-fragment envelope (order-preserving)
    geo.ts                 # great-circle distance (live-location ranking)
    clinic-directory.ts    # GENERATED: Smile branches + dental-clinic coords (from nearme c.json)
    schemas.ts             # zod validation for everything crossing a trust boundary
    status-badge.ts        # the in-page badge (shadow-DOM UI)
    messaging.ts / messaging-page.ts   # window channel (MAIN ⇄ bridge)
    transform.ts / text.ts / html.ts   # generic JSON fallback + shared pure utils
scripts/                   # dev launcher (cloned-profile Chrome) + clinic-directory generator
docs/reverse-engineering.md
```

## Clinic data

Coordinates and the full branch list come from Clalit's **public** clinic directory at
`nearme.clalit.co.il/c.json` — the same dataset behind each result row's "הצגת מפה" map link:

```bash
pnpm clinics:fetch   # regenerates src/lib/clinic-directory.ts
```

The generated file is committed, so the data is **baked into the build**: no runtime network calls,
no extra permissions. Re-run when Clalit opens or moves clinics.

## Privacy

Everything happens inside your browser, on the page you're already on. **No data leaves the
browser** — there is no server, no analytics, no storage. Geolocation is read only when you choose
the distance sort, and only to rank the already-fetched results locally.

## Dev & build

```bash
pnpm install
pnpm ext:dev      # dev loop (see below)
pnpm ext:build    # production build
pnpm ext:zip      # store-ready zip
pnpm lint         # oxlint + eslint
pnpm typecheck    # tsc --noEmit
```

`pnpm ext:dev` launches Chrome against a **clone of your real profile** (so your Clalit login
carries over) with the extension sideloaded and a **fixed CDP port** exposed for devtools tooling.
On save it **re-injects the rebuilt content scripts into the live page without reloading** — a
reload would reset the Tamuz SPA to its home screen and lose your search — with the superseded
generation standing down cleanly.

For the full story of how the booking system was mapped (the login wall, the HTML-fragment API, the
session-bound paging, the dry-run of the booking chain), read
[`docs/reverse-engineering.md`](docs/reverse-engineering.md).
