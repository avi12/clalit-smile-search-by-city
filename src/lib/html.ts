/** Shared HTML escaping - the single source of truth for both the popup and the in-page status badge. */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
};

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => HTML_ESCAPES[character] ?? character);
}
