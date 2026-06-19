const PI_OVERLAY_HIDE_THINKING_BLOCK = true
const PI_OVERLAY_CLEAR_ON_SHRINK = true

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mergePiOverlayUiSettings(settings: unknown): Record<string, unknown> {
  const merged = isPlainRecord(settings) ? { ...settings } : {}
  const terminal = isPlainRecord(merged.terminal) ? { ...merged.terminal } : {}

  terminal.clearOnShrink = PI_OVERLAY_CLEAR_ON_SHRINK
  merged.terminal = terminal
  merged.hideThinkingBlock = PI_OVERLAY_HIDE_THINKING_BLOCK

  return merged
}
