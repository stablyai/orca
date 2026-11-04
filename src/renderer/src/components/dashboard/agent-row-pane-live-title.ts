import { resolveRuntimePaneTitleForLeaf } from '../../../../shared/runtime-pane-title-leaf-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

/** Undefined preserves single-pane tab-title fallback; null suppresses unattributable split titles so siblings cannot inherit the focused pane’s name. */
export function resolveAgentRowPaneLiveTitle(
  layout: TerminalLayoutSnapshot | undefined,
  paneTitles: Record<number, string> | undefined,
  leafId: string | null | undefined
): string | null | undefined {
  if (layout?.root?.type !== 'split') {
    return undefined
  }
  if (!leafId) {
    return null
  }
  return resolveRuntimePaneTitleForLeaf(layout, paneTitles, leafId)
}
