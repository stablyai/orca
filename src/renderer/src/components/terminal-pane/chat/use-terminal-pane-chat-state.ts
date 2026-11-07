import { useTerminalPaneTabState } from '../controller/use-terminal-pane-tab-state'
import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../../../store/index'
import { resolveNativeChatLeafTitleAgent } from './native-chat-leaf-title-agent'
import { useTerminalPaneStoreActions } from '../controller/use-terminal-pane-store-actions'
import { selectUnifiedTerminalTabFields } from '../controller/tab-state/terminal-unified-tab-lookup'
import { canToggleNativeChat } from '../../../../../shared/native-chat/native-chat-availability'
import {
  nativeChatLaunchAgentForLeaf,
  resolveNativeChatLeafRoute,
  type NativeChatLeafRoute
} from '../../native-chat/native-chat-leaf-routing'
import type { TerminalPaneTitleController } from '../titles/use-terminal-pane-title-state'
import { readTerminalCursorLineContext } from '../../../../../shared/terminal/input/terminal-cursor-line-context'
import { readTerminalComposerTypedText } from '../../../../../shared/terminal/input/terminal-composer-draft'

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
    consumePendingPaneAccountRestart,
    setTabCanExpandPane,
    setTabLayout,
    setTabPaneExpanded,
    setTabViewMode,
    suppressPtyExit,
    toggleTabViewMode
  } = useTerminalPaneStoreActions()

  const {
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
  } = useTerminalPaneTabState({ tabId, worktreeId })
  const getNativeChatLeafIds = useCallback((): string[] => {
    const mountedLeafIds = managerRef.current?.getPanes().map((pane) => pane.leafId) ?? []
    return [...new Set([...expectedLayoutLeafIds, ...mountedLeafIds])]
  }, [expectedLayoutLeafIds, managerRef])
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
  }, [getNativeChatLeafIds, paneCount, tabWideAgentHintLeafId, setTabWideAgentHintLeafId])
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
    [
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      runtimePaneTitlesByPaneId,
      terminalTab?.title,
      unifiedTabLabel,
      managerRef
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
        contentType: 'terminal',
        launchAgent: detectedAgent ? null : launchAgent,
        detectedAgent,
        resolvedAgent: detectedAgent ? null : resolveTitleAgentForLeaf(leafId),
        nativeChatTranscriptIsLocalReadable
      })
    },
    [
      tabAgentTypeByLeaf,
      nativeChatTranscriptIsLocalReadable,
      terminalTab?.launchAgent,
      getNativeChatLeafIds,
      getTabWideAgentHintLeafId,
      resolveTitleAgentForLeaf
    ]
  )
  const applyNativeChatLeafRoute = useCallback(
    (route: NativeChatLeafRoute): void => {
      const state = useAppStore.getState()
      const currentMode = selectUnifiedTerminalTabFields(
        state.unifiedTabsByWorktree,
        worktreeId,
        tabId
      ).isChatViewMode
      if (!isChatViewMode && currentMode && chatLeafId && route.chatLeafId === null) {
        // Keep the owner through the batched toggle that turns chat mode on.
        return
      }
      if (route.chatLeafId !== chatLeafId) {
        setChatLeafId(route.chatLeafId)
      }
      const existingLayout = useAppStore.getState().terminalLayoutsByTabId[tabId]
      if (existingLayout && existingLayout.chatLeafId !== (route.chatLeafId ?? undefined)) {
        if (route.chatLeafId) {
          setTabLayout(tabId, { ...existingLayout, chatLeafId: route.chatLeafId })
        } else if (existingLayout?.chatLeafId) {
          const nextLayout = { ...existingLayout }
          delete nextLayout.chatLeafId
          setTabLayout(tabId, nextLayout)
        }
      }
      if (route.exitChat && unifiedTabId) {
        setTabViewMode(unifiedTabId, 'terminal')
      }
    },
    [
      chatLeafId,
      isChatViewMode,
      setTabLayout,
      setTabViewMode,
      tabId,
      unifiedTabId,
      worktreeId,
      setChatLeafId
    ]
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
          chatLeafHasConfirmedAgentExit: true
        })
      )
    },
    [applyNativeChatLeafRoute, chatLeafId, isChatEligibleForLeaf, isChatViewMode, managerRef]
  )
  useEffect(() => {
    onAgentExitedRef.current = handleConfirmedAgentExit
  }, [handleConfirmedAgentExit, onAgentExitedRef])
  const canToggleChatForLeaf = useCallback(
    (leafId: string | null): boolean => {
      // Scope the "always allow toggling back" rule to the leaf showing chat; must not make an unsupported sibling look eligible.
      const isChatViewForLeaf = effectiveChatViewMode && leafId !== null && chatLeafId === leafId
      return isChatViewForLeaf || isChatEligibleForLeaf(leafId)
    },
    [chatLeafId, effectiveChatViewMode, isChatEligibleForLeaf]
  )
  const toggleNativeChatForLeaf = useCallback(
    (leafId: string) => {
      if (!unifiedTabId) {
        return
      }
      if (effectiveChatViewMode && chatLeafId === leafId) {
        setChatLeafId(null)
        toggleTabViewMode(unifiedTabId)
        return
      }
      setChatLeafId(leafId)
      if (!effectiveChatViewMode) {
        toggleTabViewMode(unifiedTabId)
      }
    },
    [chatLeafId, effectiveChatViewMode, setChatLeafId, toggleTabViewMode, unifiedTabId]
  )
  const handleToggleNativeChat = useCallback(() => {
    const activeLeafId = managerRef.current?.getActivePane()?.leafId ?? null
    if (!activeLeafId) {
      return
    }
    toggleNativeChatForLeaf(activeLeafId)
  }, [toggleNativeChatForLeaf, managerRef])
  const switchNativeChatToTerminal = useCallback(() => {
    if (chatLeafId && unifiedTabId) {
      setChatLeafId(null)
      setTabViewMode(unifiedTabId, 'terminal')
    }
  }, [chatLeafId, setChatLeafId, setTabViewMode, unifiedTabId])
  const findNativeChatPane = useCallback(
    () =>
      chatLeafId
        ? managerRef.current?.getPanes().find((candidate) => candidate.leafId === chatLeafId)
        : undefined,
    [chatLeafId, managerRef]
  )
  const readNativeChatTerminalScreen = useCallback(
    (): string | null => findNativeChatPane()?.serializeAddon.serialize({ scrollback: 0 }) ?? null,
    [findNativeChatPane]
  )
  const readNativeChatTerminalDraft = useCallback((): string | null => {
    const pane = findNativeChatPane()
    return pane
      ? readTerminalComposerTypedText(
          readTerminalCursorLineContext(pane.terminal, pane.terminal.rows)
        )
      : null
  }, [findNativeChatPane])

  return {
    setTabPaneExpanded,
    setTabCanExpandPane,
    suppressPtyExit,
    consumePendingPaneAccountRestart,
    clearCodexRestartNotice,
    unifiedTabId,
    isChatViewMode,
    effectiveChatViewMode,
    unifiedTabLabel,
    isTabPinned,
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
    canToggleChatForLeaf,
    toggleNativeChatForLeaf,
    handleToggleNativeChat,
    applyNativeChatLeafRoute,
    switchNativeChatToTerminal,
    readNativeChatTerminalScreen,
    readNativeChatTerminalDraft
  }
}

export type TerminalPaneChatController = TerminalPaneTitleController &
  ReturnType<typeof useTerminalPaneChatState>
