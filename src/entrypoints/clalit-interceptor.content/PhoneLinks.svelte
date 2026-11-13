<!-- preserveWhitespace, because the space between two numbers is content here: Svelte trims it away by
     default, and without it the two anchors touch and their underlines read as one long link. It sits
     OUTSIDE the anchor for the same reason - inside, the underline runs straight through the gap. -->
<svelte:options preserveWhitespace />
<script lang="ts">
  import type { FormattedPhone } from "./phone-links";

  const { phones }: { phones: FormattedPhone[] } = $props();
</script>
{#each phones as phone (phone.dial)}<a
  style="text-decoration: underline;"
  dir="ltr"
  href="tel:{phone.dial}">{phone.display}</a> {/each}
