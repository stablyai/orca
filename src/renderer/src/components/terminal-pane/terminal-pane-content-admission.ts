import { useAppStore } from '@/store'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { sendLayoutApply } from '@/runtime/layout-apply-send'
import type { PaneSpawnHints } from '@/lib/pane-manager/pane-manager-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  clearWindowTabMark,
  markWindowTabStarting
} from '@/store/terminals/window-tab-start-in-main'

/** A drawn split is a durable pane intent before its renderer may start a resource. */
export function admitDrawnTerminalPane(
  worktreeId: string,
  tabId: string,
  leafId: string,
  hints: PaneSpawnHints | undefined
): void {
  const placement = hints?.placement
  const state = useAppStore.getState()
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN ||
    placement?.kind !== 'split' ||
    runtimeEnvironmentIdUnlessTwin(state, worktreeId) !== null
  ) {
    return
  }
  const mark = markWindowTabStarting(useAppStore, tabId, leafId)
  const unmark = (): void => clearWindowTabMark(useAppStore, makePaneKey(tabId, leafId), mark)
  const sent = sendLayoutApply(
    state,
    worktreeId,
    {
      type: 'splitPane',
      tabId,
      leafId: placement.parentLeafId,
      direction: placement.direction,
      ratio: placement.ratio,
      proposedRoot: placement.proposedRoot,
      newLeafId: leafId
    },
    {
      apply: unmark,
      asToday: unmark,
      refused: () => {
        const starts = useAppStore.getState().terminalPaneStartsByPaneKey
        const key = makePaneKey(tabId, leafId)
        if (starts[key] === mark) {
          useAppStore.setState({
            terminalPaneStartsByPaneKey: {
              ...starts,
              [key]: { status: 'failed', reason: 'pane creation was refused. Try splitting again.' }
            }
          })
        }
      },
      drawn: true
    }
  )
  if (!sent) {
    unmark()
  }
}
