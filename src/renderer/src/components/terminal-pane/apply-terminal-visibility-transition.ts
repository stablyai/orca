import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { ScrollState } from '@/lib/pane-manager/pane-manager-types'
import {
  hideTerminalVisibility,
  resumeTerminalVisibility,
  type TerminalHiddenReason,
  type TerminalVisibilityPostPaintRecovery
} from './terminal-visibility-resume'

export type TerminalVisibilityBookkeepingRefs = {
  wasVisibleRef: { current: boolean }
  wasWorktreeActiveRef: { current: boolean }
  hasCompletedVisibleResumeRef: { current: boolean }
  renderingSuspendedByVisibilityRef: { current: boolean }
  hiddenReasonRef: { current: TerminalHiddenReason | null }
}

type ApplyTerminalVisibilityTransitionArgs = TerminalVisibilityBookkeepingRefs & {
  manager: PaneManager | null
  rendererVisible: boolean
  isActive: boolean
  isWorktreeActive: boolean
  captureViewportPositions: (useRememberedSnapshots: boolean) => Map<number, ScrollState>
  withSuppressedScrollTracking: (callback: () => void) => void
  applyPendingFollowOutputRequests: () => void
}

// Record visible mounts before PaneManager exists so first tab hide stays light.
export function applyTerminalVisibilityTransition(
  args: ApplyTerminalVisibilityTransitionArgs
): TerminalVisibilityPostPaintRecovery | null {
  const {
    manager,
    rendererVisible,
    isActive,
    isWorktreeActive,
    wasVisibleRef,
    wasWorktreeActiveRef,
    hasCompletedVisibleResumeRef,
    renderingSuspendedByVisibilityRef,
    hiddenReasonRef,
    captureViewportPositions,
    withSuppressedScrollTracking,
    applyPendingFollowOutputRequests
  } = args

  if (!manager) {
    if (rendererVisible) {
      wasVisibleRef.current = true
      wasWorktreeActiveRef.current = isWorktreeActive
      hasCompletedVisibleResumeRef.current = true
      renderingSuspendedByVisibilityRef.current = false
      hiddenReasonRef.current = null
    } else {
      wasVisibleRef.current = false
      wasWorktreeActiveRef.current = isWorktreeActive
    }
    return null
  }

  const wasVisible = wasVisibleRef.current
  const wasWorktreeActive = wasWorktreeActiveRef.current
  if (rendererVisible) {
    const shouldUseLightTabResume =
      isWorktreeActive &&
      hasCompletedVisibleResumeRef.current &&
      !renderingSuspendedByVisibilityRef.current &&
      (wasVisible || hiddenReasonRef.current === 'tab')
    const postPaintRecovery = resumeTerminalVisibility({
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
    return postPaintRecovery
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
  return null
}
