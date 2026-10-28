import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { useEffect, useRef } from 'react'
import {
  FOCUS_TERMINAL_PANE_EVENT,
  PASTE_TERMINAL_TEXT_EVENT,
  TOGGLE_TERMINAL_PANE_EXPAND_EVENT,
  type FocusTerminalPaneDetail,
  type PasteTerminalTextDetail
} from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport-types'
import type { IDisposable } from '@xterm/xterm'
import { handleFocusTerminalPaneDetail } from './focus-terminal-pane-event'
import { surfaceStaleAgentRow } from './stale-agent-row'
import { useAppStore } from '@/store'
import { useTerminalScrollVisibilityMemory } from './use-terminal-scroll-visibility-memory'
import { useTerminalContainerFitSync } from './use-terminal-container-fit-sync'
import { handleTerminalProgrammaticTextPaste } from './terminal-programmatic-text-paste'
import {
  hideTerminalVisibility,
  resumeTerminalVisibility,
  type TerminalHiddenReason
} from './terminal-visibility-resume'
import { useTerminalWindowWakeRecovery } from './use-terminal-window-wake-recovery'
import {
  releaseRendererPtyVisibilityClaim,
  setRendererPtyVisibilityClaim
} from './pty-renderer-delivery-claims'
import { activePaneIsCoveredByNativeChat } from './native-chat-covered-pane'

type UseTerminalPaneGlobalEffectsArgs = {
  tabId: string
  cwd?: string
  isActive: boolean
  isVisible: boolean
  isChatViewMode?: boolean
  isWorktreeActive?: boolean
  isSyncFitEnabled: boolean
  paneCount: number
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  panePtyBindingsRef?: React.RefObject<Map<number, IDisposable>>
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
  toggleExpandPane: (paneId: number) => void
}

function reportRendererPtyVisibility(
  paneTransports: ReadonlyMap<number, PtyTransport>,
  visible: boolean
): void {
  for (const transport of paneTransports.values()) {
    const ptyId = transport.getPtyId()
    if (!ptyId || isRemoteRuntimePtyId(ptyId)) {
      // Remote-runtime relay PTYs bypass main’s local visibility registry.
      continue
    }
    setRendererPtyVisibilityClaim(transport, ptyId, visible)
  }
}

export function useTerminalPaneGlobalEffects({
  tabId,
  isActive,
  isVisible,
  isChatViewMode = false,
  isWorktreeActive = isVisible,
  isSyncFitEnabled,
  paneCount,
  managerRef,
  containerRef,
  paneTransportsRef,
  panePtyBindingsRef,
  isActiveRef,
  isVisibleRef,
  toggleExpandPane
}: UseTerminalPaneGlobalEffectsArgs): void {
  // Start true so initially hidden panes suspend the WebGL context openTerminal creates instead of exhausting Chromium’s context budget.
  const wasVisibleRef = useRef(true)
  const wasWorktreeActiveRef = useRef(isWorktreeActive)
  const hasCompletedVisibleResumeRef = useRef(false)
  const renderingSuspendedByVisibilityRef = useRef(false)
  const hiddenReasonRef = useRef<TerminalHiddenReason | null>(null)
  const rendererVisible = isVisible && isWorktreeActive
  // Watch leaf → PTY rebinds even without activity/visibility changes so main grants the live PTY its interactive reserve.
  const activeLeafPtyId = useAppStore((state) => {
    const layout = state.terminalLayoutsByTabId[tabId]
    const activeLeafId = layout?.activeLeafId
    return activeLeafId ? (layout.ptyIdsByLeafId?.[activeLeafId] ?? null) : null
  })
  const {
    captureViewportPositions,
    withSuppressedScrollTracking,
    applyPendingFollowOutputRequests,
    scheduleFollowOutputIfNeeded
  } = useTerminalScrollVisibilityMemory({
    managerRef,
    isVisibleRef,
    visibleResumeCompleteRef: wasVisibleRef,
    paneCount
  })
  useTerminalContainerFitSync({
    isVisible: rendererVisible,
    isSyncFitEnabled,
    managerRef,
    containerRef
  })
  useTerminalWindowWakeRecovery({
    isVisible: rendererVisible,
    isChatViewMode,
    managerRef,
    isActiveRef,
    isVisibleRef,
    panePtyBindingsRef
  })

  useEffect(() => {
    const paneTransports = paneTransportsRef.current
    reportRendererPtyVisibility(paneTransports, rendererVisible)
    return () => {
      for (const transport of paneTransports.values()) {
        releaseRendererPtyVisibilityClaim(transport)
      }
    }
  }, [rendererVisible, paneTransportsRef])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    manager.setAtlasRecoveryVisible?.(rendererVisible)
    // Why: hidden-worktree panes keep their WebGL backing; tab-hidden ones may release it (pane-webgl-renderer).
    containerRef.current?.toggleAttribute('data-worktree-surface-hidden', !isWorktreeActive)
    const wasVisible = wasVisibleRef.current
    const wasWorktreeActive = wasWorktreeActiveRef.current
    isActiveRef.current = isActive
    isVisibleRef.current = rendererVisible
    if (rendererVisible) {
      const shouldUseLightTabResume =
        isWorktreeActive &&
        hasCompletedVisibleResumeRef.current &&
        !renderingSuspendedByVisibilityRef.current &&
        (wasVisible || hiddenReasonRef.current === 'tab')
      resumeTerminalVisibility({
        manager,
        isActive,
        // Tab-wide chat covers only its chat leaf; active split terminals still need reveal focus.
        isChatViewMode: isChatViewMode && activePaneIsCoveredByNativeChat(manager),
        wasVisible,
        shouldUseLightTabResume,
        captureViewportPositions,
        withSuppressedScrollTracking
      })
      renderingSuspendedByVisibilityRef.current = false
      wasVisibleRef.current = true
      wasWorktreeActiveRef.current = isWorktreeActive
      hasCompletedVisibleResumeRef.current = true
      hiddenReasonRef.current = null
      applyPendingFollowOutputRequests()
      return
    }
    const hiddenState = hideTerminalVisibility({
      manager,
      wasVisible,
      wasWorktreeActive,
      isWorktreeActive,
      hasCompletedVisibleResume: hasCompletedVisibleResumeRef.current,
      captureViewportPositions
    })
    renderingSuspendedByVisibilityRef.current = hiddenState.renderingSuspended
    hiddenReasonRef.current = hiddenState.hiddenReason

    wasVisibleRef.current = false
    wasWorktreeActiveRef.current = isWorktreeActive
  }, [
    isActive,
    isChatViewMode,
    isWorktreeActive,
    rendererVisible,
    applyPendingFollowOutputRequests,
    captureViewportPositions,
    containerRef,
    isActiveRef,
    isVisibleRef,
    managerRef,
    withSuppressedScrollTracking
  ])

  useEffect(() => {
    const ptyId = isActive && isVisible && isWorktreeActive ? activeLeafPtyId : null
    if (!ptyId || isRemoteRuntimePtyId(ptyId)) {
      return
    }
    // Main prioritizes this PTY’s bounded ACK reserve; cleanup deactivates the old binding before rebind.
    window.api.pty.setActiveRendererPty?.(ptyId, true)
    return () => window.api.pty.setActiveRendererPty?.(ptyId, false)
  }, [isActive, isVisible, isWorktreeActive, activeLeafPtyId])

  useEffect(() => {
    const onToggleExpand = (event: Event): void => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail
      if (!detail?.tabId || detail.tabId !== tabId) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length < 2) {
        return
      }
      const pane = manager.getActivePane() ?? panes[0]
      if (!pane) {
        return
      }
      toggleExpandPane(pane.id)
    }
    window.addEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
    return () => window.removeEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  useEffect(() => {
    const onFocusPane = (event: Event): void => {
      const detail = (event as CustomEvent<FocusTerminalPaneDetail | undefined>).detail
      handleFocusTerminalPaneDetail(detail, {
        tabId,
        manager: managerRef.current,
        acknowledgeAgents: (paneKeys) => useAppStore.getState().acknowledgeAgents(paneKeys),
        surfaceStaleAgentRow,
        scrollToBottomIfOutputSinceLastView: scheduleFollowOutputIfNeeded
      })
    }
    window.addEventListener(FOCUS_TERMINAL_PANE_EVENT, onFocusPane)
    return () => window.removeEventListener(FOCUS_TERMINAL_PANE_EVENT, onFocusPane)
  }, [tabId, managerRef, scheduleFollowOutputIfNeeded])

  useEffect(() => {
    const onPasteText = (event: Event): void => {
      const detail = (event as CustomEvent<PasteTerminalTextDetail | undefined>).detail
      handleTerminalProgrammaticTextPaste({
        detail,
        tabId,
        getManager: () => managerRef.current,
        getPaneTransports: () => paneTransportsRef.current
      })
    }
    window.addEventListener(PASTE_TERMINAL_TEXT_EVENT, onPasteText)
    return () => window.removeEventListener(PASTE_TERMINAL_TEXT_EVENT, onPasteText)
  }, [tabId, managerRef, paneTransportsRef])

  // Global dictation events must reach only the active pane or every mounted tab inserts the text.
  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }
    const onDictationInsert = (event: Event): void => {
      if (!isActiveRef.current) {
        return
      }
      const detail = (
        event as CustomEvent<string | { text?: string; tabId?: string; paneId?: number }>
      ).detail
      const text = typeof detail === 'string' ? detail : detail?.text
      if (!text) {
        return
      }
      if (typeof detail === 'object' && detail.tabId && detail.tabId !== tabId) {
        return
      }
      const requestedPaneId = typeof detail === 'object' ? detail.paneId : undefined
      handleTerminalProgrammaticTextPaste({
        detail: {
          tabId,
          text,
          ...(typeof requestedPaneId === 'number' ? { paneId: requestedPaneId } : {})
        },
        tabId,
        getManager: () => managerRef.current,
        getPaneTransports: () => paneTransportsRef.current
      })
    }
    document.addEventListener('dictation:insertText', onDictationInsert)
    return () => document.removeEventListener('dictation:insertText', onDictationInsert)
  }, [isActiveRef, managerRef, paneTransportsRef, tabId])
}
