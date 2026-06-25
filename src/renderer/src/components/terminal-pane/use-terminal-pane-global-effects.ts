import { useEffect, useRef } from 'react'
import {
  FOCUS_TERMINAL_PANE_EVENT,
  PASTE_TERMINAL_TEXT_EVENT,
  TOGGLE_TERMINAL_PANE_EXPAND_EVENT,
  type FocusTerminalPaneDetail,
  type PasteTerminalTextDetail
} from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { resetAllTerminalWebglAtlases } from '@/lib/pane-manager/pane-manager-registry'
import type { PtyTransport } from './pty-transport'
import { handleTerminalFileDrop } from './terminal-drop-handler'
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

type UseTerminalPaneGlobalEffectsArgs = {
  tabId: string
  worktreeId: string
  cwd?: string
  isActive: boolean
  isVisible: boolean
  isWorktreeActive?: boolean
  isSyncFitEnabled: boolean
  paneCount: number
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
  toggleExpandPane: (paneId: number) => void
}

export function useTerminalPaneGlobalEffects({
  tabId,
  worktreeId,
  cwd,
  isActive,
  isVisible,
  isWorktreeActive = isVisible,
  isSyncFitEnabled,
  paneCount,
  managerRef,
  containerRef,
  paneTransportsRef,
  isActiveRef,
  isVisibleRef,
  toggleExpandPane
}: UseTerminalPaneGlobalEffectsArgs): void {
  const worktreeIdRef = useRef(worktreeId)
  worktreeIdRef.current = worktreeId
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  // Starts true so the first render with isVisible=false triggers a
  // suspendRendering(). Background worktrees that mount hidden would
  // otherwise leak WebGL contexts — openTerminal() unconditionally creates
  // one — and exhaust Chromium's ~8-context budget across worktrees.
  const wasVisibleRef = useRef(true)
  const wasWorktreeActiveRef = useRef(isWorktreeActive)
  const hasCompletedVisibleResumeRef = useRef(false)
  const renderingSuspendedByVisibilityRef = useRef(false)
  const hiddenReasonRef = useRef<TerminalHiddenReason | null>(null)
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
  useTerminalContainerFitSync({ isVisible, isSyncFitEnabled, managerRef, containerRef })

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    const wasVisible = wasVisibleRef.current
    const wasWorktreeActive = wasWorktreeActiveRef.current
    isActiveRef.current = isActive
    isVisibleRef.current = isVisible
    if (isVisible) {
      const shouldUseLightTabResume =
        isWorktreeActive &&
        hasCompletedVisibleResumeRef.current &&
        !renderingSuspendedByVisibilityRef.current &&
        (wasVisible || hiddenReasonRef.current === 'tab')
      resumeTerminalVisibility({
        manager,
        isActive,
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
    } else {
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
    }
    wasVisibleRef.current = false
    wasWorktreeActiveRef.current = isWorktreeActive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, isVisible, isWorktreeActive])

  useEffect(() => {
    if (!isVisible) {
      return
    }
    const recoverWebglAtlases = (): void => {
      // Why: WebGL atlas corruption does not always raise context loss; window
      // foregrounding is a low-cost recovery point. Visible terminals can be
      // inactive in split groups, and same-config terminals share the atlas.
      resetAllTerminalWebglAtlases()
    }
    const onFocus = (): void => recoverWebglAtlases()
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        recoverWebglAtlases()
      }
    }
    window.addEventListener('focus', onFocus)
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    return () => {
      window.removeEventListener('focus', onFocus)
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }
  }, [isVisible])

  useEffect(() => {
    const manager = managerRef.current
    const activePane = isActive && isVisible ? manager?.getActivePane() : null
    const ptyId = activePane
      ? (paneTransportsRef.current.get(activePane.id)?.getPtyId() ?? null)
      : null
    if (!ptyId || ptyId.startsWith('remote:')) {
      return
    }
    // Why: main uses this as a scheduler hint only, so the foreground pane's
    // renderer output gets first chance at the bounded ACK reserve.
    window.api.pty.setActiveRendererPty?.(ptyId, true)
    return () => window.api.pty.setActiveRendererPty?.(ptyId, false)
  }, [isActive, isVisible, managerRef, paneTransportsRef])

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
        worktreeId: worktreeIdRef.current,
        getManager: () => managerRef.current,
        getPaneTransports: () => paneTransportsRef.current
      })
    }
    window.addEventListener(PASTE_TERMINAL_TEXT_EVENT, onPasteText)
    return () => window.removeEventListener(PASTE_TERMINAL_TEXT_EVENT, onPasteText)
  }, [tabId, managerRef, paneTransportsRef])

  // Why: dictation events are dispatched globally; gate on isActiveRef so only
  // the foreground terminal pane consumes the inserted text — otherwise text
  // would be duplicated across all mounted but inactive tabs.
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
        worktreeId: worktreeIdRef.current,
        getManager: () => managerRef.current,
        getPaneTransports: () => paneTransportsRef.current
      })
    }
    document.addEventListener('dictation:insertText', onDictationInsert)
    return () => document.removeEventListener('dictation:insertText', onDictationInsert)
  }, [isActiveRef, managerRef, paneTransportsRef, tabId])

  // Why: visible but unfocused split-group terminals can still receive native
  // OS drops. Route tab-id-aware payloads to the dropped pane, while legacy
  // payloads without a tab id keep the old active-terminal-only behavior.
  useEffect(() => {
    if (!isActive && !isVisible) {
      return
    }
    return window.api.ui.onFileDrop((data) => {
      if (data.target !== 'terminal') {
        return
      }
      if (data.tabId) {
        if (data.tabId !== tabId) {
          return
        }
      } else if (!isActive) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const wtId = worktreeIdRef.current
      if (!wtId) {
        return
      }
      void handleTerminalFileDrop({
        manager,
        paneTransports: paneTransportsRef.current,
        worktreeId: wtId,
        tabId,
        cwd: cwdRef.current,
        data
      })
    })
  }, [isActive, isVisible, managerRef, paneTransportsRef, tabId])
}
