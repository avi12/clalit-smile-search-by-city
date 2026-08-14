/**
 * The in-page status badge - a Svelte component inside a WXT shadow-root UI showing whether the city
 * guarantee is active, which city it's guarding (read from the search box), and the last result's
 * in-city count. Pure UI: it owns its DOM and knows nothing about messaging. The bridge feeds it
 * state and a toggle callback; updates land in a $state proxy the component reads reactively, so a
 * badge that mounts late (the shadow-root UI creation is async) shows current state. Component CSS is
 * compiled into the JS (`css: "injected"`, shadow-root-aware), so mounting needs no chrome.* APIs and
 * works in the dev loop's re-injected MAIN-world generations too.
 */

import type { GuaranteeStatus } from "./messaging";
import StatusBadge from "./StatusBadge.svelte";
import { type ContentScriptContext, createShadowRootUi } from "#imports";
import { mount, unmount } from "svelte";

export interface BadgeState {
  isEnabled: boolean;
  city: string;
  status: GuaranteeStatus | null;
}

export interface StatusBadgeHandle {
  update(state: BadgeState): void;
  /** Remove the badge from the page (a superseded dev generation standing down). */
  destroy(): void;
}

const HOST_TAG = "clalit-city-badge";

export function mountStatusBadge(ctx: ContentScriptContext, onToggle: () => void): StatusBadgeHandle {
  const state = $state<BadgeState>({
    isEnabled: true,
    city: "",
    status: null
  });
  let ui: Awaited<ReturnType<typeof createUi>> | null = null;
  let isDestroyed = false;

  function createUi() {
    return createShadowRootUi(ctx, {
      name: HOST_TAG,
      position: "overlay",
      alignment: "bottom-left",
      zIndex: 2147483647,
      anchor: "body",
      onMount(container, _shadow, shadowHost) {
        // WXT's overlay positioning is anchor-relative; the badge floats over the viewport instead.
        shadowHost.style.position = "fixed";
        shadowHost.style.bottom = "16px";
        shadowHost.style.left = "16px";
        return mount(StatusBadge, {
          target: container,
          props: {
            state,
            onToggle
          }
        });
      },
      onRemove(app) {
        if (app) {
          void unmount(app);
        }
      }
    });
  }

  void createUi()
    .then(created => {
      if (isDestroyed) {
        created.remove();
        return;
      }

      for (const stale of document.querySelectorAll(HOST_TAG)) {
        stale.remove(); // a leftover host from a superseded dev generation
      }

      ui = created;
      created.autoMount();
    })
    .catch((error: unknown) => {
      if (import.meta.env.DEV) {
        console.warn("[clalit-city] status badge mount failed", error);
      }
    });

  return {
    update(next) {
      Object.assign(state, next);
    },
    destroy() {
      isDestroyed = true;
      ui?.remove();
    }
  };
}
