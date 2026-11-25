import { collectLeafIds } from '../../../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import {
  sampleSourcePane,
  type DetachTerminalPaneToTabArgs,
  type SourcePaneSample
} from './terminal-pane-tab-detach-steps'

/** How long a committed move waits for its source tab's mount to show the pane again. */
const COMMITTED_SOURCE_REMOUNT_WAIT_MS = 3_000
const REMOUNT_RESAMPLE_MS = 16

function sourceLayoutHoldsLeaf(args: DetachTerminalPaneToTabArgs, leafId: string): boolean {
  const root = args.getStore().terminalLayoutsByTabId[args.sourceTabId]?.root
  return root ? collectLeafIds(root).includes(leafId) : false
}

/**
 * The source pane once main has committed its move. A tab can be between mounts (an Activity
 * portal hop, a manager rebuild) while its saved layout still holds the leaf; that is not a vanished
 * pane, so the move waits briefly for the current mount to draw it again, and failing that applies
 * to the saved layout alone (`unmounted`): the next mount draws the source without the pane. Only a
 * leaf gone from the source layout is a vanished pane (null).
 */
export async function sourceAfterCommit(
  args: DetachTerminalPaneToTabArgs,
  leafId: string
): Promise<SourcePaneSample | 'unmounted' | null> {
  const deadline = Date.now() + COMMITTED_SOURCE_REMOUNT_WAIT_MS
  for (;;) {
    const sample = sampleSourcePane(args, leafId)
    if (sample) {
      return sample
    }
    if (!sourceLayoutHoldsLeaf(args, leafId)) {
      return null
    }
    if (Date.now() >= deadline) {
      return 'unmounted'
    }
    await new Promise((resolve) => setTimeout(resolve, REMOUNT_RESAMPLE_MS))
  }
}
