/** Markdown blockquote of reply text, ending in a blank line so the user types below it. */
export function formatNativeChatQuote(text: string): string {
  const lines = text.trim().split(/\r?\n/)
  return `${lines.map((line) => (line.trim() ? `> ${line}` : '>')).join('\n')}\n\n`
}
