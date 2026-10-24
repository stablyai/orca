import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import type {
  PaneForegroundAgentTracker,
  PaneForegroundAgentTrackerDeps
} from './pane-foreground-agent-tracker-contract'

type TransitionHost = {
  deps: PaneForegroundAgentTrackerDeps
  disposed: () => boolean
  hasCommandReadInFlight: () => boolean
  cancelPendingRead: () => void
  markForegroundAgentEvidence: () => void
  clearAgentEvidence: () => void
  resetStartup: () => void
}

export function createPaneForegroundObservationTransitions(
  host: TransitionHost
): Pick<
  PaneForegroundAgentTracker,
  'onForegroundAgentObserved' | 'onShellForegroundObserved' | 'onProcessExitConfirmed'
> {
  const {
    deps,
    disposed,
    hasCommandReadInFlight,
    cancelPendingRead,
    markForegroundAgentEvidence,
    clearAgentEvidence,
    resetStartup
  } = host
  return {
    onForegroundAgentObserved(process) {
      const published = deps.getPublishedEntry?.()
      if (
        disposed() ||
        hasCommandReadInFlight() ||
        published?.routingRevoked ||
        published?.routingConfirmationPending
      ) {
        return
      }
      cancelPendingRead()
      markForegroundAgentEvidence()
      deps.publish({
        agent: process.agent,
        agentEvidence: 'process-read',
        routingTrusted: true,
        shellForeground: false
      })
      deps.onVisibleForegroundSettled?.('agent')
    },
    onShellForegroundObserved() {
      if (disposed()) {
        return
      }
      if (!hasCommandReadInFlight()) {
        cancelPendingRead()
      }
      deps.publish({ agent: null, shellForeground: true })
    },
    onProcessExitConfirmed(process) {
      if (disposed()) {
        return
      }
      const published = deps.getPublishedEntry?.()
      cancelPendingRead()
      clearAgentEvidence()
      resetStartup()
      if (
        published?.shellForeground ||
        (published?.agentEvidence === 'process-read' &&
          resolveCompatibleAgentTypeForOwner(process.agent, published.agent) === published.agent)
      ) {
        deps.publish({ agent: null, shellForeground: published.shellForeground })
      }
    }
  }
}
