import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { closeStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-close'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { readAgentSessionErrorRefusal } from '../../../../../shared/agent-session/failures/agent-session-write-failure'
import { retireStructuredAgentSessionReadOwner } from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner-registry'
import { stopStructuredAgentSessionSends } from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender'
import { forgetStructuredSessionSelection } from '@/lib/agent-session/options/structured-agent-session-selection-controller'
import {
  nativeChatAuxiliaryParentKey,
  type NativeChatAuxiliaryChild
} from '@/store/slices/right-sidebar/native-chat-auxiliary-state'
import type { AgentSessionHistoryResult } from '../../../../../shared/agent-session/agent-session-wire'

export type NativeChatAuxiliaryChildGuard =
  | { kind: 'ok' }
  | { kind: 'missing' }
  | { kind: 'blocked'; reason: string }

const childGuards = new Map<string, Promise<NativeChatAuxiliaryChildGuard>>()

/** Closes and forgets one child; the parent chat and its tab are never touched. */
export function closeNativeChatAuxiliaryChild(child: NativeChatAuxiliaryChild): void {
  const key = nativeChatAuxiliaryParentKey({
    sessionId: child.parentSessionId,
    target: child.target
  })
  useAppStore.getState().removeNativeChatAuxiliaryChild(key, child.sessionId)
  stopStructuredAgentSessionSends(child.sessionId)
  retireStructuredAgentSessionReadOwner(child.sessionId, child.target)
  forgetStructuredSessionSelection(child.sessionId, child.target)
  void closeStructuredAgentSession(child.target, child.sessionId).catch(() => undefined)
}

/**
 * A missing child is stale and closable; a pending prompt blocks references; any other answer or
 * silence short of a true missing refusal leaves the child usable.
 */
function guardNativeChatAuxiliaryChild(
  child: NativeChatAuxiliaryChild
): Promise<NativeChatAuxiliaryChildGuard> {
  const existing = childGuards.get(child.sessionId)
  if (existing) {
    return existing
  }
  const guard = (async (): Promise<NativeChatAuxiliaryChildGuard> => {
    const feed = getStructuredAgentSessionStatusFeed(child.target)
    const summary = feed.getSnapshot().get(child.sessionId)
    if (summary?.sleptAt !== undefined) {
      return {
        kind: 'blocked',
        reason: translate(
          'components.rightSidebar.sideChat.childAsleep',
          'That side chat is asleep. Start a new one.'
        )
      }
    }
    if (summary?.status === 'attention' || summary?.awaitsAnswer === true) {
      return {
        kind: 'blocked',
        reason: translate(
          'components.rightSidebar.sideChat.childWaiting',
          'Answer this side chat before adding another selection.'
        )
      }
    }
    // Auxiliary children are not broadcast globally; a targeted read is the only presence proof.
    const timeout = Promise.withResolvers<'timeout'>()
    const timer = setTimeout(() => timeout.resolve('timeout'), 4_000)
    try {
      await Promise.race([
        callStructuredAgentSession<AgentSessionHistoryResult>(
          child.target,
          'agentSession.history',
          { sessionId: child.sessionId, direction: 'tail', limit: 1 }
        ),
        timeout.promise
      ])
      return { kind: 'ok' }
    } catch (error) {
      const refusal = readAgentSessionErrorRefusal(error)
      return refusal?.code === 'agent_session_identity_required' &&
        (refusal.details?.reason === 'recordMissing' ||
          refusal.details?.reason === 'transcriptNotFound')
        ? { kind: 'missing' }
        : { kind: 'ok' }
    } finally {
      clearTimeout(timer)
    }
  })()
  childGuards.set(child.sessionId, guard)
  void guard.finally(() => childGuards.delete(child.sessionId))
  return guard
}

/** Exposed for panel routing; stale children close before they can receive a selection. */
export async function ensureNativeChatAuxiliaryChildRoutable(
  child: NativeChatAuxiliaryChild
): Promise<NativeChatAuxiliaryChildGuard> {
  const guard = await guardNativeChatAuxiliaryChild(child)
  if (guard.kind === 'missing') {
    closeNativeChatAuxiliaryChild(child)
  }
  return guard
}
