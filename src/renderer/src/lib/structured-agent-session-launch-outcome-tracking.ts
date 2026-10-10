import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import {
  settleStructuredLaunchCallers,
  structuredLaunchCallersHavePendingWork
} from '@/lib/structured-agent-session-launch-callers'
import type { StructuredAgentLaunchReceipt } from '@/lib/structured-agent-session-launch-recovery'
import { structuredLaunchFailure } from './structured-agent-session-launch-failure'
import {
  deleteStructuredLaunchStateIfCurrent,
  notifyStructuredLaunchListeners,
  retireStructuredAgentSessionLaunchCancellationTombstone,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

// How a launch's create outcome settles its callers: published, refused, failed or unknown.

function cleanupLaunchState(state: StructuredLaunchState): void {
  if (deleteStructuredLaunchStateIfCurrent(state)) {
    notifyStructuredLaunchListeners()
  }
}

export function maybeCleanupLaunchState(state: StructuredLaunchState): void {
  if (
    state.callers.outcome === 'failed' ||
    structuredLaunchCallersHavePendingWork(state.callers) ||
    Object.keys(state.selection.held).length > 0
  ) {
    return
  }
  cleanupLaunchState(state)
}

function settleStructuredLaunchRefusal(state: StructuredLaunchState): void {
  if (state.callers.outcome !== 'pending' && state.callers.outcome !== 'unknown') {
    return
  }
  retireStructuredAgentSessionLaunchCancellationTombstone(
    state.intent.worktreeId,
    state.intent.sessionId
  )
  settleStructuredLaunchCallers(state.callers, 'failed')
  notifyStructuredLaunchListeners()
}

export function trackLaunchSettlement(
  state: StructuredLaunchState,
  promise: Promise<StructuredAgentLaunchReceipt>
): void {
  void promise.then(
    () => {
      if (state.promise !== promise) {
        return
      }
      settleStructuredLaunchCallers(state.callers, 'published')
      notifyStructuredLaunchListeners()
    },
    (error) => {
      if (state.promise !== promise) {
        return
      }
      if (state.cancelled) {
        if (error instanceof StructuredAgentSessionCreateRefusalError) {
          retireStructuredAgentSessionLaunchCancellationTombstone(
            state.intent.worktreeId,
            state.intent.sessionId
          )
        }
        return
      }
      // The chat's Retry line owns the failed start's guidance.
      console.warn('[native-chat] structured launch failed', error)
      const failure = structuredLaunchFailure(error)
      if (failure) {
        state.failure = failure
      } else {
        delete state.failure
      }
      if (error instanceof StructuredAgentSessionCreateRefusalError) {
        settleStructuredLaunchRefusal(state)
      } else if (!state.visibilityUnknown) {
        settleStructuredLaunchCallers(state.callers, 'failed')
        notifyStructuredLaunchListeners()
      } else {
        state.callers.outcome = 'unknown'
        notifyStructuredLaunchListeners()
      }
    }
  )
}
