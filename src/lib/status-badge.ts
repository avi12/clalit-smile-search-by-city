/**
 * The in-page status badge — a shadow-DOM widget showing whether the city guarantee is active, which
 * city it's guarding (read from the search box), and the last result's in-city count. Pure UI: it owns
 * its DOM and knows nothing about messaging. The bridge feeds it state and a toggle callback.
 */

import { escapeHtml } from "./html";
import type { GuaranteeStatus } from "./messaging";

export interface BadgeState {
  enabled: boolean;
  city: string;
  status: GuaranteeStatus | null;
}

export interface StatusBadge {
  update(state: BadgeState): void;
  /** Remove the badge from the page (a superseded dev generation standing down). */
  destroy(): void;
}

const HOST_ID = "clalit-city-badge-host";

const STYLE = /* html */ `<style>
  :host { all: initial; }
  .badge {
    --pri: #1f6b4f; --surface: #f3faf6; --on-surface: #12241d; --outline: #c3d9cf;
    display: flex; align-items: center; gap: 10px; direction: rtl;
    font-family: "Segoe UI", Roboto, system-ui, sans-serif;
    background: var(--surface); color: var(--on-surface);
    border: 1px solid var(--outline); border-radius: 20px;
    padding: 8px 14px 8px 10px; box-shadow: 0 6px 20px rgba(0,0,0,.16);
    max-width: 300px;
  }
  .dot { width: 20px; height: 20px; border-radius: 999px; border: none; cursor: pointer;
         background: var(--outline); transition: background .2s cubic-bezier(.2,0,0,1); flex: 0 0 auto; }
  .badge.on .dot { background: var(--pri); }
  .title { font-size: 13px; font-weight: 650; }
  .sub { font-size: 11px; opacity: .75; margin-top: 1px; }
  .stat { color: var(--pri); font-weight: 700; }
  @media (prefers-color-scheme: dark) {
    .badge { --pri: #7fd8b0; --surface: #17211d; --on-surface: #e3f1ea; --outline: #33463e; }
    .stat { color: var(--pri); }
  }
</style>`;

export function mountStatusBadge(onToggle: () => void): StatusBadge {
  let host: HTMLElement | null = null;
  let shadowRoot: ShadowRoot | null = null;
  let latest: BadgeState | null = null;

  function ensureBox(): HTMLElement | null {
    if (!document.body) {
      return null;
    }

    if (!shadowRoot) {
      document.getElementById(HOST_ID)?.remove(); // a stale host from a superseded generation
      host = document.createElement("div");
      host.id = HOST_ID;
      host.style.cssText = "position:fixed;z-index:2147483647;bottom:16px;left:16px;";
      document.body.appendChild(host);
      shadowRoot = host.attachShadow({ mode: "open" });
      shadowRoot.innerHTML = `${STYLE}<div class="badge"></div>`;
    }

    return shadowRoot.querySelector<HTMLElement>(".badge");
  }

  function render() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", render, { once: true });
      return;
    }

    const box = ensureBox();
    if (!box || !latest) {
      return;
    }

    const { enabled, city, status } = latest;
    const on = enabled && city.trim().length > 0;
    const stat = status
      ? `<span class="stat">${status.inCityCount}/${status.resultsCount} בעיר</span>`
      : "";

    box.className = `badge ${on ? "on" : "off"}`;
    box.innerHTML = `
      <button class="dot" title="הפעל/כבה אחריות עיר" aria-label="toggle"></button>
      <div class="text">
        <div class="title">${enabled ? "אחריות עיר פעילה" : "אחריות עיר כבויה"}</div>
        <div class="sub">${city ? escapeHtml(city) : "הקלד עיר בתיבת החיפוש"} ${stat}</div>
      </div>`;
    box.querySelector(".dot")?.addEventListener("click", onToggle);
  }

  return {
    update(state) {
      latest = state;
      render();
    },
    destroy() {
      host?.remove();
      host = null;
      shadowRoot = null;
    }
  };
}
