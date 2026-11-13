/**
 * The in-page status badge - a Svelte component inside a WXT shadow-root UI showing whether the city
 * guarantee is active, which city it's guarding (read from the search box), and the last result's
 * in-city count. Pure UI: it owns its DOM and knows nothing about messaging. The bridge feeds it
 * state and a toggle callback; updates land in a $state proxy the component reads reactively, so a
 * badge that mounts late (the shadow-root UI creation is async) shows current state. Component CSS is
 * compiled into the JS (`css: "injected"`, shadow-root-aware), so mounting needs no browser.* APIs and
 * works in the dev loop's re-injected MAIN-world generations too.
 */

import { mount, unmount } from "svelte";

import { type ContentScriptContext, createShadowRootUi } from "#imports";
import type { GuaranteeStatus } from "@/lib/messaging";

import StatusBadge from "./StatusBadge.svelte";

const MAX_Z_INDEX = 2_147_483_647;

export interface BadgeState {
  isEnabled: boolean;
  city: string;
  status: GuaranteeStatus | null;
}

interface StatusBadgeHandle {
  update(state: BadgeState): void;
  /** Remove the badge from the page (a superseded dev generation standing down). */
  destroy(): void;
}

const HOST_TAG = "clalit-city-badge";

export function mountStatusBadge({
  ctx,
  onToggle
}: {
  ctx: ContentScriptContext;
  onToggle: () => void;
}): StatusBadgeHandle {
  const state = $state<BadgeState>({
    isEnabled: true,
    city: "",
    status: null
  });
  let badgeUi: Awaited<ReturnType<typeof createUi>> | null = null;
  let isDestroyed = false;

  function createUi() {
    return createShadowRootUi(ctx, {
      name: HOST_TAG,
      position: "overlay",
      alignment: "bottom-left",
      zIndex: MAX_Z_INDEX,
      anchor: "body",
      onMount(elContainer, _shadow, elShadowHost) {
        // WXT's overlay positioning is anchor-relative; the badge floats over the viewport instead.
        elShadowHost.style.position = "fixed";
        elShadowHost.style.bottom = "16px";
        elShadowHost.style.left = "16px";
        return mount(StatusBadge, {
          target: elContainer,
          props: {
            state,
            onToggle
          }
        });
      },
      async onRemove(app) {
        if (app) {
          await unmount(app);
        }
      }
    });
  }

  async function mountUi() {
    const created = await createUi();
    if (isDestroyed) {
      created.remove();
      return;
    }

    for (const elStale of document.querySelectorAll(HOST_TAG)) {
      elStale.remove(); // a leftover host from a superseded dev generation
    }

    badgeUi = created;
    created.autoMount();
  }

  mountUi().catch((error: unknown) => {
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
      badgeUi?.remove();
    }
  };
}
