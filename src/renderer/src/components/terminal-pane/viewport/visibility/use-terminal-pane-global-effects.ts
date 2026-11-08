import { useRendererPtyVisibilityClaims } from '../../pty-transport/delivery/use-renderer-pty-visibility-claims'
import { useActiveRendererPty } from '../../pty-transport/delivery/use-active-renderer-pty'
import { syncPaneOutputCadences } from '../../pty-transport/renderer-active-pty'
import { useTerminalPaneExpandEvent } from '../../layout/expand/use-terminal-pane-expand-event'
import { useTerminalPaneFocusEvent } from '../../input/focus/use-terminal-pane-focus-event'
import { useTerminalProgrammaticPasteEvent } from '../../input/paste/use-terminal-programmatic-paste-event'
import { useTerminalDictationInsertEvent } from '../../input/paste/use-terminal-dictation-insert-event'
import { useEffect, useRef } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import type { IDisposable } from '@xterm/xterm'
import { useAppStore } from '@/store/index'
import { useTerminalScrollVisibilityMemory } from './use-terminal-scroll-visibility-memory'
import { useTerminalContainerFitSync } from '../use-terminal-container-fit-sync'
import {
  hideTerminalVisibility,
  resumeTerminalVisibility,
  type TerminalHiddenReason
} from './terminal-visibility-resume'
import { useTerminalWindowWakeRecovery } from './use-terminal-window-wake-recovery'
import { activePaneIsCoveredByNativeChat } from '../../chat/native-chat-covered-pane'

type UseTerminalPaneGlobalEffectsArgs = {
  tabId: string
  cwd?: string
  isActive: boolean
  isVisible: boolean
  isChatViewMode?: boolean
  isWorktreeActive?: boolean
  isSyncFitEnabled: boolean
  /** Keep WebGL attached in a laid-out hidden host so a likely reveal skips context and atlas setup. */
  warmRendererWhileHidden?: boolean
  paneCount: number
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  panePtyBindingsRef?: React.RefObject<Map<number, IDisposable>>
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
  toggleExpandPane: (paneId: number) => void
}

export function useTerminalPaneGlobalEffects({
  tabId,
  isActive,
  isVisible,
  isChatViewMode = false,
  isWorktreeActive = isVisible,
  isSyncFitEnabled,
  warmRendererWhileHidden = false,
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
  const warmedWhileHiddenRef = useRef(false)
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

  useRendererPtyVisibilityClaims({ paneTransportsRef, rendererVisible })

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
      warmedWhileHiddenRef.current = false
      applyPendingFollowOutputRequests()
      return
    }
    if (warmRendererWhileHidden && isWorktreeActive === false) {
      if (wasVisible) {
        captureViewportPositions(false)
      }
      manager.resumeRendering()
      warmedWhileHiddenRef.current = true
      renderingSuspendedByVisibilityRef.current = false
      hiddenReasonRef.current = 'surface'
      wasVisibleRef.current = false
      wasWorktreeActiveRef.current = isWorktreeActive
      return
    }
    if (warmedWhileHiddenRef.current) {
      // Warm-up ended without a reveal; release the context like any hidden worktree.
      warmedWhileHiddenRef.current = false
      manager.suspendRendering()
      renderingSuspendedByVisibilityRef.current = true
      hiddenReasonRef.current = 'surface'
      wasVisibleRef.current = false
      wasWorktreeActiveRef.current = isWorktreeActive
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
    warmRendererWhileHidden,
    applyPendingFollowOutputRequests,
    captureViewportPositions,
    containerRef,
    isActiveRef,
    isVisibleRef,
    managerRef,
    withSuppressedScrollTracking
  ])

  useEffect(() => {
    if (panePtyBindingsRef) {
      syncPaneOutputCadences(panePtyBindingsRef.current)
    }
  }, [isActive, panePtyBindingsRef])

  useActiveRendererPty({ isActive, isVisible, isWorktreeActive, activeLeafPtyId })

  useTerminalPaneExpandEvent({ tabId, managerRef, toggleExpandPane })

  useTerminalPaneFocusEvent({ tabId, managerRef, scheduleFollowOutputIfNeeded, toggleExpandPane })

  useTerminalProgrammaticPasteEvent({ tabId, managerRef, paneTransportsRef })

  useTerminalDictationInsertEvent({ isActiveRef, managerRef, paneTransportsRef, tabId })
}
