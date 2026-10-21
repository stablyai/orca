/** DSH-TUI titles are always `<prefix> 🐋 <session title>` (its Chat screen's
 *  `useTerminalTitle`), and the whale is the only part no other agent emits. It has to
 *  outrank the Gemini glyphs below: DSH's IDLE prefix is `✦`, which is Gemini's WORKING
 *  glyph, so without this a resting DSH pane reads as a working Gemini — wrong agent,
 *  wrong state. Evidence: src/main/runtime/__fixtures__/dsh-tui-ready-no-key.txt. */
export const DSH_WHALE = '\u{1F40B}' // 🐋

export function isDshTerminalTitle(title: string): boolean {
  return title.includes(DSH_WHALE)
}
