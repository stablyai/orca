/** DSH Chat useTerminalTitle uses prefix/whale/session. Whale identity must outrank Gemini’s working ✦ because DSH uses it for idle. Capture: src/main/runtime/__fixtures__/dsh-tui-ready-no-key.txt. */
export const DSH_WHALE = '\u{1F40B}' // 🐋

export function isDshTerminalTitle(title: string): boolean {
  return title.includes(DSH_WHALE)
}
