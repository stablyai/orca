import type { TerminalLeafId } from '../../../../shared/stable-pane-id'

// Why: moving a live pane into or out of the Agents view remounts TerminalPane.
// Keep session-only zoom by durable leaf ID so that UI move does not reset it.
const fontSizeByLeafId = new Map<TerminalLeafId, number>()

export function hydrateTerminalFontSizeOverride(
  pane: { id: number; leafId: TerminalLeafId },
  paneFontSizes: Map<number, number>
): void {
  const fontSize = fontSizeByLeafId.get(pane.leafId)
  if (fontSize === undefined) {
    paneFontSizes.delete(pane.id)
    return
  }
  paneFontSizes.set(pane.id, fontSize)
}

export function setTerminalFontSizeOverride(leafId: TerminalLeafId, fontSize: number): void {
  fontSizeByLeafId.set(leafId, fontSize)
}

export function clearTerminalFontSizeOverride(leafId: TerminalLeafId): void {
  fontSizeByLeafId.delete(leafId)
}

export function resetTerminalFontSizeOverridesForTest(): void {
  fontSizeByLeafId.clear()
}
