import { retireStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner-registry'
import { useAppStore } from '@/store/index'
import { publishStructuredAgentSessionSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import { agentSessionWriteFailureText } from '@/components/native-chat/agent-session-write-notice-text'
import { getAgentLabel } from '@/lib/agent-catalog'
import { removeStructuredLaunchSlot } from './structured-agent-session-launch-slot'
import {
  materializeStructuredLaunchSurface,
  findStructuredLaunchTab
} from './structured-agent-session-launch-surface'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import {
  settleStructuredLaunchCallers,
  structuredLaunchCallersHavePendingWork
} from '@/lib/agent-session/launch/structured-agent-session-launch-callers'
import type { StructuredAgentLaunchReceipt } from '@/lib/agent-session/launch/structured-agent-session-launch-recovery'
import { structuredLaunchFailure } from './structured-agent-session-launch-failure'
import {
  StructuredHostLaunchNotStartedError,
  StructuredHostLaunchTerminalError
} from './structured-agent-session-host-launch'
import { hostLaunchAwaitsItsTab } from './structured-agent-session-host-launch-retention'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { nativeChatComposerHasUserContent } from '@/components/native-chat/native-chat-pending-attachment-cache'
import { afterPendingTab } from '@/runtime/layout-owner-pending-tabs'
import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  deleteStructuredLaunchStateIfCurrent,
  notifyStructuredLaunchListeners,
  retireStructuredAgentSessionLaunchCancellationTombstone,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import { recordUnlistedCreatedChat } from '../../structured-agent-session-unlisted-created-chats'
import { forgetStructuredSessionSelection } from '../../structured-agent-session-selection-controller'

function cleanupLaunchState(state: StructuredLaunchState): void {
  if (deleteStructuredLaunchStateIfCurrent(state)) {
    notifyStructuredLaunchListeners()
  }
}

export function maybeCleanupLaunchState(state: StructuredLaunchState): void {
  if (state.callers.outcome === 'failed' || structuredLaunchCallersHavePendingWork(state.callers)) {
    return
  }
  cleanupLaunchState(state)
}

/** The chat's tab shows here now: a host launch kept only for want of it retires as any other. */
export function reconsiderShownHostLaunch(state: StructuredLaunchState): void {
  if (state.intent.hostLaunch && !hostLaunchAwaitsItsTab(state)) {
    maybeCleanupLaunchState(state)
    notifyStructuredLaunchListeners()
  }
}

/** The host started its terminal and took the text, and nothing else waits in the chat: that
 *  terminal is the launch's surface, so a chat never shown has nothing left to recover. */
function hostLaunchSettledInTerminal(state: StructuredLaunchState, error: unknown): boolean {
  return (
    error instanceof StructuredHostLaunchTerminalError &&
    !state.intent.hostLaunch?.firstMessage &&
    !nativeChatComposerHasUserContent(structuredAgentSessionDraftScopeKey(state.intent.sessionId))
  )
}

function cleanupUnmaterializedLaunch(state: StructuredLaunchState, error?: unknown): boolean {
  const adoptedElsewhere = hostLaunchSettledInTerminal(state, error)
  if (
    state.intent.surfaceAddress &&
    !findStructuredLaunchTab(state.intent) &&
    (adoptedElsewhere || !hostLaunchAwaitsItsTab(state))
  ) {
    removeStructuredLaunchSlot(
      useAppStore.getState(),
      state.intent.worktreeId,
      state.intent.sessionId
    )
    if (deleteStructuredLaunchStateIfCurrent(state, adoptedElsewhere || undefined)) {
      forgetStructuredSessionSelection(state.intent.sessionId, state.intent.target)
      return true
    }
  }
  return false
}

function settleStructuredLaunchRefusal(state: StructuredLaunchState, error: unknown): void {
  if (state.callers.outcome !== 'pending' && state.callers.outcome !== 'unknown') {
    return
  }
  retireStructuredAgentSessionLaunchCancellationTombstone(
    state.intent.worktreeId,
    state.intent.sessionId
  )
  settleStructuredLaunchCallers(state.callers, 'failed')
  if (cleanupUnmaterializedLaunch(state, error)) {
    retireStructuredAgentSessionReadOwner(state.intent.sessionId, state.intent.target)
  }
  notifyStructuredLaunchListeners()
}

export function trackLaunchSettlement(
  state: StructuredLaunchState,
  promise: Promise<StructuredAgentLaunchReceipt>
): void {
  void promise.then(
    (receipt) => {
      if (state.promise !== promise) {
        return
      }
      if (state.cancelled) {
        return
      }
      state.visibilityUnknown = false
      materializeStructuredLaunchSurface(state.intent)
      if (state.intent.hostLaunch) {
        afterPendingTab(structuredAgentSessionTabId(state.intent.sessionId), () =>
          reconsiderShownHostLaunch(state)
        )
      }
      if (!state.hostListed) {
        const { worktreeId, sessionId, executionHostId } = state.intent
        recordUnlistedCreatedChat(worktreeId, sessionId, executionHostId)
      }
      if (receipt.configurationFailure) {
        publishStructuredAgentSessionSends(receipt.sessionId, {
          notice: `${getAgentLabel(state.intent.agent)}: ${agentSessionWriteFailureText(receipt.configurationFailure, 'option')}`
        })
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
      const failure =
        error instanceof StructuredHostLaunchNotStartedError
          ? error.failure
          : structuredLaunchFailure(error)
      if (failure) {
        state.failure = failure
      } else {
        delete state.failure
      }
      if (error instanceof StructuredAgentSessionCreateRefusalError) {
        settleStructuredLaunchRefusal(state, error)
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
