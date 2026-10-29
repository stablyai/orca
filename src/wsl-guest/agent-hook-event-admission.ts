import { transitionHookPresence } from '../shared/agent-hook-presence-transition'
import { hasOtherAgentProcessOwner, isSameAgentProcess } from '../shared/agent-process-presence'
import { sameAgentStatusTerminalOwner } from '../shared/agent-status-terminal-owner'
import { cacheRelayLegacyAgentStatus } from '../shared/agent-status-legacy-relay-cache'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import { retainClaudeSettledRequests } from '../shared/agent-hook-listener/claude-settled-permission-requests'
import { reduceHostTurnEnd } from '../shared/agent-hook-turn-end-timing'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'
import type { RelayHookForward } from './agent-hook-server-contract'
import { MAX_CACHED_PANES, type CachedPaneEnvelopeMeta } from './agent-hook-cached-pane-status'
import {
  reconcileRelayClaudeCancel,
  withRelayClaudeTurnRevision
} from './agent-hook-interrupt-reconciliation'

type RelayHookAdmissionHost = {
  state: HookListenerState
  metadata: Map<string, CachedPaneEnvelopeMeta>
  isCanonicalPane: (paneKey: string) => boolean
  isPaneSurfaceRetired: (paneKey: string) => boolean
  clearPaneState: (paneKey: string) => void
  clearAssistantMessageRetry: (paneKey: string) => void
  forward: RelayHookForward
  checkAgentPresence: (paneKey: string) => Promise<void>
}

export function applyRelayHookEvent(
  host: RelayHookAdmissionHost,
  incoming: AgentHookEventPayload,
  source: AgentHookSource,
  env?: string,
  version?: string,
  options: { isReplay?: boolean; checkPresence?: boolean } = {}
): AgentHookEventPayload | undefined {
  if (host.isCanonicalPane(incoming.paneKey)) {
    return undefined
  }
  const previous = host.state.lastStatusByPaneKey.get(incoming.paneKey)
  if (
    previous &&
    !previous.providerSessionOnly &&
    sameAgentStatusTerminalOwner(previous, incoming) &&
    hasOtherAgentProcessOwner(previous.agentPresence, {
      agent: incoming.payload.agentType ?? 'unknown',
      process: incoming.agentPresence?.process
    })
  ) {
    return undefined
  }
  const cancellation = reconcileRelayClaudeCancel(host.state, previous, incoming, source)
  if (cancellation.hold) {
    return previous
  }
  const transitioned = transitionHookPresence(cancellation.event, previous)
  if (!transitioned) {
    return undefined
  }
  const revised = withRelayClaudeTurnRevision(
    previous,
    transitioned.agentPresence?.ended
      ? { ...transitioned, providerSessionOnly: true }
      : transitioned,
    source
  )
  // Why: the relay is this pane's execution host, the only side that sees the event name.
  const {
    stopHookActive: _stopHookActive,
    nativeTurnKey: _nativeTurnKey,
    turnEndedAt: _turnEndedAt,
    turnEndDisposition: _turnEndDisposition,
    hostTurn: _hostTurn,
    ...unflagged
  } = revised
  const event: AgentHookEventPayload = {
    ...unflagged,
    ...reduceHostTurnEnd(previous, revised, Date.now(), options.isReplay !== true)
  }
  // Drop retired-pane posts and cached status so clients cannot auto-resume a ghost pane onto an orphan’s live transcript (#12447).
  if (host.isPaneSurfaceRetired(event.paneKey)) {
    host.clearPaneState(event.paneKey)
    return undefined
  }
  if (event.payload.state !== 'done' || event.payload.lastAssistantMessage) {
    host.clearAssistantMessageRetry(event.paneKey)
  }
  // Retain PostCompact replay identity so reconnect can recheck ownership instead of resurrecting a retired pane.
  if (
    !cacheRelayLegacyAgentStatus(host.state, event, MAX_CACHED_PANES, (paneKey) =>
      host.clearPaneState(paneKey)
    )
  ) {
    return undefined
  }
  const claudeSettledRequests = retainClaudeSettledRequests(
    host.metadata.get(event.paneKey)?.claudeSettledRequests,
    previous,
    event
  )
  host.metadata.delete(event.paneKey)
  host.metadata.set(event.paneKey, {
    source,
    env,
    version,
    ...(claudeSettledRequests ? { claudeSettledRequests } : {})
  })
  host.forward(buildRelayHookEnvelope(event, source, env, version, options))
  const sender = incoming.agentPresence?.process
  const owner = event.agentPresence
  // Why: a live hook proves its own process alive; only another process's hook casts doubt on the owner.
  if (
    options.checkPresence !== false &&
    sender &&
    owner?.process &&
    !owner.ended &&
    !isSameAgentProcess(sender, owner.process)
  ) {
    void host.checkAgentPresence(event.paneKey)
  }
  // Why: retries compare against the cached row by identity, so they must hold that exact row.
  return host.state.lastStatusByPaneKey.get(event.paneKey)
}
