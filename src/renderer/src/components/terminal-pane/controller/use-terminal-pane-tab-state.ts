import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../store/index'
import { getCachedTerminalTabForWorktree } from './tab-state/terminal-tab-lookup'
import { useTerminalTabAgentTypes } from '../titles/use-terminal-tab-agent-types'
import '../layout/terminal-layout-leaf-traversal'
import { collectLayoutLeafIdsInOrder } from '../../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import { EMPTY_LAYOUT } from '../layout/empty-terminal-layout'
import { sanitizeTerminalLayoutPaneTitles } from '../../../../../shared/workspace-layout/terminal-topology/terminal-pane-title-sanitization'
import { selectUnifiedTerminalTabFields } from './tab-state/terminal-unified-tab-lookup'
import type { TerminalPaneTitleController } from '../titles/use-terminal-pane-title-state'

export function useTerminalPaneTabState({
  tabId,
  worktreeId
}: Pick<TerminalPaneTitleController, 'tabId' | 'worktreeId'>) {
  // Bundle unified-tab reads to reduce lookups and subscriptions per mounted tab.
  const { unifiedTabId, isChatViewMode, unifiedTabLabel, isTabPinned } = useAppStore(
    useShallow((store) =>
      selectUnifiedTerminalTabFields(store.unifiedTabsByWorktree, worktreeId, tabId)
    )
  )
  const effectiveChatViewMode = isChatViewMode
  const runtimePaneTitlesByPaneId = useAppStore(
    useShallow((store) => store.runtimePaneTitlesByTabId[tabId] ?? {})
  )
  const tabAgentTypeByLeaf = useTerminalTabAgentTypes(tabId)
  const savedLayout = useAppStore((store) => store.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT)
  const terminalTab = useAppStore((store) =>
    getCachedTerminalTabForWorktree(store.tabsByWorktree, worktreeId, tabId)
  )
  const restoredLayout = useMemo(
    () => (terminalTab ? sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab) : savedLayout),
    [savedLayout, terminalTab]
  )
  const expectedLayoutLeafIds = useMemo(
    () => collectLayoutLeafIdsInOrder(restoredLayout.root),
    [restoredLayout.root]
  )
  return {
    unifiedTabId,
    isChatViewMode,
    unifiedTabLabel,
    isTabPinned,
    effectiveChatViewMode,
    runtimePaneTitlesByPaneId,
    tabAgentTypeByLeaf,
    savedLayout,
    terminalTab,
    restoredLayout,
    expectedLayoutLeafIds
  }
}
