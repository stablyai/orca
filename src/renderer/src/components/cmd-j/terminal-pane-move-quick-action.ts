import { PanelTopOpen } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import { requestActiveTerminalPaneMoveToNewTab } from '@/components/terminal-pane/layout/detach/terminal-pane-move-request-routing'
import type { CmdJQuickAction } from './quick-actions'
import type { CmdJQuickActionContext } from './quick-action-context'

export type ActiveTerminalPaneMove = { worktreeId: string; tabId: string }

/** The terminal tab the user sees, when it has a pane to move and another to keep. */
export function resolveActiveTerminalPaneMove(
  state: Pick<
    AppState,
    | 'activeTabId'
    | 'activeTabType'
    | 'tabsByWorktree'
    | 'groupsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'terminalLayoutsByTabId'
  >,
  worktreeId: string | null,
  groupId: string | null
): ActiveTerminalPaneMove | null {
  if (!worktreeId) {
    return null
  }
  // The shown terminal is activeTabId; a group's own active tab can lag it.
  const shownTabId =
    state.activeTabType === 'terminal' &&
    state.activeTabId &&
    state.tabsByWorktree[worktreeId]?.some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : null
  const group = groupId
    ? state.groupsByWorktree[worktreeId]?.find((entry) => entry.id === groupId)
    : undefined
  const tabId =
    shownTabId ??
    state.unifiedTabsByWorktree[worktreeId]?.find(
      (entry) => entry.id === group?.activeTabId && entry.contentType === 'terminal'
    )?.entityId
  const layout = tabId ? state.terminalLayoutsByTabId[tabId] : undefined
  if (!tabId || !layout?.root) {
    return null
  }
  return collectLayoutLeafIdsInOrder(layout.root).length < 2 ? null : { worktreeId, tabId }
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
      if (!move || !requestActiveTerminalPaneMoveToNewTab(move.worktreeId, move.tabId)) {
        return { status: 'unavailable', reason: 'no-movable-pane' }
      }
      return { status: 'ok' }
    }
  }
}
