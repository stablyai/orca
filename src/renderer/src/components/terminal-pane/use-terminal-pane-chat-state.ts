import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { useAppStore } from '../../store'
import { getCachedTerminalTabForWorktree } from './terminal-tab-lookup'
import { selectTerminalTabAgentTypesByLeaf } from './terminal-tab-agent-type-index'
import { collectLeafIdsInOrder, EMPTY_LAYOUT } from './layout-serialization'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { sanitizeTerminalLayoutPaneTitles } from '@/lib/terminal-pane-title-sanitization'
import { resolveNativeChatLeafTitleAgent } from './native-chat-leaf-title-agent'
import { useTerminalPaneStoreActions } from './use-terminal-pane-store-actions'
import { selectUnifiedTerminalTabChatFields } from './terminal-unified-tab-lookup'
import { canToggleNativeChat } from '../native-chat/native-chat-availability'
import {
  nativeChatLaunchAgentForLeaf,
  resolveNativeChatLeafRoute,
  type NativeChatLeafRoute
} from '../native-chat/native-chat-leaf-routing'
import type { TerminalPaneTitleController } from './use-terminal-pane-title-state'

export function useTerminalPaneChatState(controller: TerminalPaneTitleController) {
  const {
    chatLeafId,
    managerRef,
    nativeChatTranscriptIsLocalReadable,
    onAgentExitedRef,
    paneCount,
    setChatLeafId,
    setTabWideAgentHintLeafId,
    tabId,
    tabWideAgentHintLeafId,
    worktreeId
  } = controller
  const {
    clearCodexRestartNotice,
    consumePendingCodexPaneRestart,
    setTabCanExpandPane,
    setTabPaneExpanded,
    setTabViewMode,
    suppressPtyExit
  } = useTerminalPaneStoreActions()
  const pendingCodexPaneRestartIds = useAppStore((store) => store.pendingCodexPaneRestartIds)
  // Why one selector: five separate subscriptions each re-read the same unified
  // tab, so one publication paid the lookup five times per mounted tab.
  const {
    unifiedTabId,
    structuredSessionAgent,
    isChatViewMode,
    structuredSessionId,
    unifiedTabLabel
  } = useAppStore(
    useShallow((store) =>
      selectUnifiedTerminalTabChatFields(store.unifiedTabsByWorktree, worktreeId, tabId)
    )
  )
  const nativeChatEnabled = useAppStore((store) => store.settings?.experimentalNativeChat === true)
  const effectiveChatViewMode = nativeChatEnabled && isChatViewMode
  const chatPaneDispatchStatus = useAppStore((store) =>
    chatLeafId
      ? store.agentStatusByPaneKey[makePaneKey(tabId, chatLeafId)]?.orchestration?.dispatchStatus
      : undefined
  )
  const runtimePaneTitlesByPaneId = useAppStore(
    useShallow((store) => store.runtimePaneTitlesByTabId[tabId] ?? {})
  )
  const tabAgentTypeByLeaf = useAppStore((store) =>
    selectTerminalTabAgentTypesByLeaf(
      store.agentStatusByPaneKey,
      tabId,
      store.paneForegroundAgentByPaneKey
    )
  )
  const savedLayout = useAppStore((store) => store.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT)
  const terminalTab = useAppStore((store) =>
    getCachedTerminalTabForWorktree(store.tabsByWorktree, worktreeId, tabId)
  )
  const restoredLayout = useMemo(
    () => (terminalTab ? sanitizeTerminalLayoutPaneTitles(savedLayout, terminalTab) : savedLayout),
    [savedLayout, terminalTab]
  )
  const expectedLayoutLeafIds = useMemo(
    () => collectLeafIdsInOrder(restoredLayout.root),
    [restoredLayout.root]
  )
  const getNativeChatLeafIds = useCallback((): string[] => {
    const mountedLeafIds = managerRef.current?.getPanes().map((pane) => pane.leafId) ?? []
    return [...new Set([...expectedLayoutLeafIds, ...mountedLeafIds])]
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [expectedLayoutLeafIds])
  const getTabWideAgentHintLeafId = useCallback((): string | null => {
    if (tabWideAgentHintLeafId !== undefined) {
      return tabWideAgentHintLeafId
    }
    const leafIds = getNativeChatLeafIds()
    return leafIds.length === 1 ? leafIds[0] : null
  }, [getNativeChatLeafIds, tabWideAgentHintLeafId])
  const getTabWideAgentHintLeafIdRef = useRef(getTabWideAgentHintLeafId)
  useEffect(() => {
    getTabWideAgentHintLeafIdRef.current = getTabWideAgentHintLeafId
  }, [getTabWideAgentHintLeafId])
  useEffect(() => {
    if (tabWideAgentHintLeafId !== undefined) {
      return
    }
    const leafIds = getNativeChatLeafIds()
    if (leafIds.length === 0) {
      return
    }
    setTabWideAgentHintLeafId(leafIds.length === 1 ? leafIds[0] : null)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [getNativeChatLeafIds, paneCount, tabWideAgentHintLeafId])
  const resolveTitleAgentForLeaf = useCallback(
    (leafId: string | null) => {
      const hasSingleKnownLeaf =
        getNativeChatLeafIds().length === 1 && getTabWideAgentHintLeafId() === leafId
      return resolveNativeChatLeafTitleAgent({
        leafId,
        panes: managerRef.current?.getPanes() ?? [],
        runtimePaneTitlesByPaneId,
        tabLabel: hasSingleKnownLeaf ? unifiedTabLabel : null,
        terminalTitle: hasSingleKnownLeaf ? terminalTab?.title : null
      })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      runtimePaneTitlesByPaneId,
      terminalTab?.title,
      unifiedTabLabel
    ]
  )
  const isChatEligibleForLeaf = useCallback(
    (leafId: string | null): boolean => {
      const detectedAgent = leafId ? (tabAgentTypeByLeaf[leafId] ?? null) : null
      const launchAgent = nativeChatLaunchAgentForLeaf({
        launchAgent: terminalTab?.launchAgent,
        launchAgentLeafId: getTabWideAgentHintLeafId(),
        leafId,
        leafIds: getNativeChatLeafIds()
      })
      return canToggleNativeChat({
        experimentalNativeChatEnabled: nativeChatEnabled,
        contentType: 'terminal',
        launchAgent: detectedAgent ? null : launchAgent,
        detectedAgent,
        // A structured handoff keeps the durable provider identity even when the
        // foreground hook has not republished agent status after returning to TUI.
        resolvedAgent: detectedAgent
          ? null
          : ((structuredSessionAgent as TuiAgent | null) ?? resolveTitleAgentForLeaf(leafId)),
        nativeChatTranscriptIsLocalReadable
      })
    },
    [
      tabAgentTypeByLeaf,
      nativeChatEnabled,
      structuredSessionAgent,
      nativeChatTranscriptIsLocalReadable,
      terminalTab?.launchAgent,
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      resolveTitleAgentForLeaf
    ]
  )
  const applyNativeChatLeafRoute = useCallback(
    (route: NativeChatLeafRoute): void => {
      if (route.chatLeafId !== chatLeafId) {
        setChatLeafId(route.chatLeafId)
      }
      if (route.exitChat && unifiedTabId) {
        setTabViewMode(unifiedTabId, 'terminal')
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [chatLeafId, setTabViewMode, unifiedTabId]
  )
  const handleConfirmedAgentExit = useCallback(
    (leafId: string): void => {
      if (leafId !== chatLeafId) {
        return
      }
      const panes = managerRef.current?.getPanes() ?? []
      const activeLeafId = managerRef.current?.getActivePane()?.leafId ?? null
      applyNativeChatLeafRoute(
        resolveNativeChatLeafRoute({
          isChatViewMode,
          chatLeafId,
          activeLeafId,
          chatLeafStillMounted: panes.some((pane) => pane.leafId === chatLeafId),
          activeLeafIsEligible: isChatEligibleForLeaf(activeLeafId),
          chatLeafHasConfirmedAgentExit: true,
          structuredSessionId
        })
      )
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [
      applyNativeChatLeafRoute,
      chatLeafId,
      isChatEligibleForLeaf,
      isChatViewMode,
      structuredSessionId
    ]
  )
  useEffect(() => {
    onAgentExitedRef.current = handleConfirmedAgentExit
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [handleConfirmedAgentExit])
  const switchNativeChatToTerminal = useCallback(() => {
    if (chatLeafId && unifiedTabId) {
      setChatLeafId(null)
      setTabViewMode(unifiedTabId, 'terminal')
    }
  }, [chatLeafId, setChatLeafId, setTabViewMode, unifiedTabId])
  const readNativeChatTerminalScreen = useCallback((): string | null => {
    if (!chatLeafId) {
      return null
    }
    const pane = managerRef.current?.getPanes().find((candidate) => candidate.leafId === chatLeafId)
    return pane?.serializeAddon.serialize({ scrollback: 0 }) ?? null
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- managerRef is a stable ref container.
  }, [chatLeafId])

  return {
    setTabPaneExpanded,
    setTabCanExpandPane,
    suppressPtyExit,
    pendingCodexPaneRestartIds,
    consumePendingCodexPaneRestart,
    clearCodexRestartNotice,
    unifiedTabId,
    structuredSessionAgent,
    isChatViewMode,
    structuredSessionId,
    nativeChatEnabled,
    effectiveChatViewMode,
    chatPaneDispatchStatus,
    unifiedTabLabel,
    runtimePaneTitlesByPaneId,
    tabAgentTypeByLeaf,
    setTabViewMode,
    savedLayout,
    terminalTab,
    restoredLayout,
    expectedLayoutLeafIds,
    getNativeChatLeafIds,
    getTabWideAgentHintLeafId,
    getTabWideAgentHintLeafIdRef,
    resolveTitleAgentForLeaf,
    isChatEligibleForLeaf,
    applyNativeChatLeafRoute,
    switchNativeChatToTerminal,
    readNativeChatTerminalScreen
  }
}

export type TerminalPaneChatController = TerminalPaneTitleController &
  ReturnType<typeof useTerminalPaneChatState>
