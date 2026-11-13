<script lang="ts">
  import type { BadgeState } from "./status-badge.svelte";

  const { state, onToggle }: {
    state: BadgeState;
    onToggle: () => void 
  } = $props();

  const isOn = $derived(state.isEnabled && state.city.trim().length > 0);
</script>

<div class="badge" class:on={isOn}>
  <button class="dot" aria-label="toggle" onclick={onToggle} title="הפעל/כבה אחריות עיר"></button>
  <div class="text">
    <div class="title">{state.isEnabled ? "אחריות עיר פעילה" : "אחריות עיר כבויה"}</div>
    <div class="sub">
      {state.city || "הקלד עיר בתיבת החיפוש"}
      {#if state.status}
        <span class="stat">{state.status.inCityCount}/{state.status.resultsCount} בעיר</span>
      {/if}
    </div>
  </div>
</div>

<style>
  .badge {
    --pri: #1f6b4f;
    --surface: #f3faf6;
    --on-surface: #12241d;
    --outline: #c3d9cf;

    display: flex;
    gap: 10px;
    align-items: center;
    max-width: 300px;
    padding: 8px 14px 8px 10px;
    border: 1px solid var(--outline);
    border-radius: 20px;
    background: var(--surface);
    color: var(--on-surface);
    font-family: "Segoe UI", Roboto, system-ui, sans-serif;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.16);
    direction: rtl;
  }

  .dot {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 999px;
    background: var(--outline);
    cursor: pointer;
    transition: background 0.2s cubic-bezier(0.2, 0, 0, 1);
  }

  .badge.on .dot {
    background: var(--pri);
  }

  .title {
    font-weight: 650;
    font-size: 13px;
  }

  .sub {
    margin-top: 1px;
    font-size: 11px;
    opacity: 0.75;
  }

  .stat {
    color: var(--pri);
    font-weight: 700;
  }

  @media (prefers-color-scheme: dark) {
    .badge {
      --pri: #7fd8b0;
      --surface: #17211d;
      --on-surface: #e3f1ea;
      --outline: #33463e;
    }
  }
</style>
