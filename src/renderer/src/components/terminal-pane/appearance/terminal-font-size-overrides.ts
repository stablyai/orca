// Keyed by durable leaf id so per-pane zoom survives TerminalPane remounts (hidden-tab parking).
const fontSizeByLeafId = new Map<string, number>()

export function getTerminalFontSizeOverride(leafId: string): number | undefined {
  return fontSizeByLeafId.get(leafId)
}

export function setTerminalFontSizeOverride(leafId: string, fontSize: number): void {
  fontSizeByLeafId.set(leafId, fontSize)
}

export function clearTerminalFontSizeOverride(leafId: string): void {
  fontSizeByLeafId.delete(leafId)
}
