import { useAppStore } from '@/store/index'
import { removeStructuredLaunchSlot } from './structured-agent-session-launch-slot'
import {
  materializeStructuredLaunchSurface,
  findStructuredLaunchTab
} from '../../structured-agent-session-launch-surface'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/structured-agent-session-launch-errors'
import {
  settleStructuredLaunchCallers,
  structuredLaunchCallersHavePendingWork
} from '@/lib/structured-agent-session-launch-callers'
import type { StructuredAgentLaunchReceipt } from '@/lib/agent-session/launch/structured-agent-session-launch-recovery'
import { structuredLaunchFailure } from '../../structured-agent-session-launch-failure'
import {
  deleteStructuredLaunchStateIfCurrent,
  notifyStructuredLaunchListeners,
  retireStructuredAgentSessionLaunchCancellationTombstone,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import { recordUnlistedCreatedChat } from '../../structured-agent-session-unlisted-created-chats'

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

function cleanupUnmaterializedLaunch(state: StructuredLaunchState): void {
  if (state.intent.surfaceAddress && !findStructuredLaunchTab(state.intent)) {
    removeStructuredLaunchSlot(
      useAppStore.getState(),
      state.intent.worktreeId,
      state.intent.sessionId
    )
    cleanupLaunchState(state)
  }
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
  cleanupUnmaterializedLaunch(state)
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
      if (state.cancelled) {
        return
      }
      materializeStructuredLaunchSurface(state.intent)
      if (!state.hostListed) {
        const { worktreeId, sessionId, executionHostId } = state.intent
        recordUnlistedCreatedChat(worktreeId, sessionId, executionHostId)
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
        cleanupUnmaterializedLaunch(state)
        notifyStructuredLaunchListeners()
      } else {
        state.callers.outcome = 'unknown'
        materializeStructuredLaunchSurface(state.intent)
        notifyStructuredLaunchListeners()
      }
    }
  )
}
