import { PanelTopOpen } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import { requestTerminalPaneMoveToNewTab } from '@/components/terminal-pane/layout/detach/terminal-pane-move-request-routing'
import type { CmdJQuickAction } from './quick-actions'
import type { CmdJQuickActionContext } from './quick-action-context'

export type ActiveTerminalPaneMove = { worktreeId: string; tabId: string; leafId: string }

/** The active pane of the active group's terminal tab, when that tab has another pane to keep. */
export function resolveActiveTerminalPaneMove(
  state: Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'>,
  worktreeId: string | null,
  groupId: string | null
): ActiveTerminalPaneMove | null {
  if (!worktreeId || !groupId) {
    return null
  }
  const group = state.groupsByWorktree[worktreeId]?.find((entry) => entry.id === groupId)
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (entry) => entry.id === group?.activeTabId && entry.contentType === 'terminal'
  )
  const layout = tab ? state.terminalLayoutsByTabId[tab.entityId] : undefined
  if (!tab || !layout?.root) {
    return null
  }
  const leafIds = collectLayoutLeafIdsInOrder(layout.root)
  const leafId = layout.activeLeafId
  if (leafIds.length < 2 || !leafId || !leafIds.includes(leafId)) {
    return null
  }
  return { worktreeId, tabId: tab.entityId, leafId }
}

function availability(ctx: CmdJQuickActionContext) {
  return ctx.activePaneMove
    ? ({ available: true } as const)
    : ({ available: false, reason: 'no-movable-pane' } as const)
}

export function getTerminalPaneMoveQuickAction(): CmdJQuickAction {
  const title = translate(
    'components.terminalPane.movePaneToNewTab.paletteTitle',
    'Move Pane to New Tab'
  )
  return {
    id: 'move-pane-to-new-tab',
    kind: 'action',
    title,
    description: translate(
      'components.terminalPane.movePaneToNewTab.paletteDescription',
      'Move the active split pane into its own tab.'
    ),
    icon: PanelTopOpen,
    verbKeywords: [
      title,
      translate('components.terminalPane.movePaneToNewTab.verbs.splitToTab', 'split to tab'),
      translate('components.terminalPane.movePaneToNewTab.verbs.detachPane', 'detach pane')
    ],
    isAvailable: availability,
    run: async (ctx) => {
      const move = ctx.activePaneMove
      if (!move || !requestTerminalPaneMoveToNewTab(move.worktreeId, move.tabId, move.leafId)) {
        return { status: 'unavailable', reason: 'no-movable-pane' }
      }
      return { status: 'ok' }
    }
  }
}
