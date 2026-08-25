import { resolveRuntimePaneTitleForLeaf } from '@/lib/runtime-pane-title-leaf-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

/**
 * The live terminal title of the pane an agent row belongs to, for tabs holding
 * more than one pane.
 *
 * `undefined` means the tab holds a single pane, so its tab title already IS
 * that pane's title and the caller should keep using it. `null` means the tab
 * is split but this pane's own title could not be attributed, so no live title
 * belongs to the row — showing the tab title there would show a sibling's.
 *
 * Cost: a single-pane tab pays one property read and returns, so the common tab
 * shape is unchanged. A split tab walks only its own pane-title slots against
 * its own layout tree; no global map is scanned.
 */
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
