import { shouldClearLaunchAgentAfterSplitPaneClose } from '@/components/terminal-pane/terminal-pane-close-identity'
import { detachTerminalLayoutLeaf } from '@/components/terminal-pane/terminal-layout-leaf-detach'
import type { AppState } from '@/store/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/types'

export function runTerminalSplitPaneAgentCloseCleanup(args: {
  tabId: string
  worktreeId: string
  closedPaneId: number
  closedLeafId: string
  closedPtyId: string | null
  survivingPaneIds: ReadonlySet<number>
  survivingPaneKeys: readonly string[]
  getState: () => AppState
}): void {
  const store = args.getState()
  const terminalTab = store.tabsByWorktree[args.worktreeId]?.find(
    (candidate) => candidate.id === args.tabId
  )
  const closedPaneKey = makePaneKey(args.tabId, args.closedLeafId)
  const detachedLayout = detachTerminalLayoutLeaf(
    store.terminalLayoutsByTabId[args.tabId],
    args.closedLeafId
  )
  if (detachedLayout) {
    store.setTabLayout(args.tabId, detachedLayout.sourceLayout)
  }
  if (
    shouldClearLaunchAgentAfterSplitPaneClose({
      tab: terminalTab as Pick<TerminalTab, 'launchAgent' | 'ptyId'> | undefined,
      closedPtyId: args.closedPtyId,
      closedPaneId: args.closedPaneId,
      closedPaneKey,
      runtimePaneTitlesByPaneId: store.runtimePaneTitlesByTabId[args.tabId] ?? {},
      survivingPaneKeys: args.survivingPaneKeys,
      agentStatusByPaneKey: store.agentStatusByPaneKey
    })
  ) {
    store.clearTabLaunchAgent(args.tabId)
  }
  store.retireAgentPaneAuthority(closedPaneKey)
  store.suppressTitleDerivedAgentLeaf(args.tabId, args.closedLeafId)
  store.setCacheTimerStartedAt(closedPaneKey, null)
  store.dropAgentStatus(closedPaneKey)
  store.retainRuntimePaneTitlesForTab(args.tabId, args.survivingPaneIds)
}
