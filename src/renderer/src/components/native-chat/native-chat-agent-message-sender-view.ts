import { useCallback, useMemo } from 'react'
import {
  useAgentMessageSenderSource,
  useAgentMessageSenderSources,
  useLeasedSenderSelector
} from './native-chat-agent-message-sender-source'
import type { AgentMessageSenderTarget } from './native-chat-agent-message-sender-target'
import type { AppState } from '@/store/types'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  agentMessageSenderCandidateLocation,
  agentMessageSenderOpens,
  resolveAgentMessageSenderTarget
} from './native-chat-agent-message-sender-target'
import { parseOrcaSessionAddress } from '../../../../shared/orca-session-address'
import { agentMessageSavedKind } from '../../../../shared/agent-session/agent-message-presentation'

/** A terminal may outlive its sender; only a saved actor reference selects current activity. */
function activitySender(
  sender: AgentMessageSender | undefined,
  dispatchId?: string
): AgentMessageSender | undefined {
  if (!sender) {
    return
  }
  const session = sender.party.orcaSessionId ?? parseOrcaSessionAddress(sender.party.address)
  const address = session
    ? `orca_session_id:${session}`
    : dispatchId
      ? `dispatch:${dispatchId}`
      : sender.party.address.startsWith('dispatch:')
        ? sender.party.address
        : undefined
  return address
    ? { ...sender, party: { address, orcaSessionId: session, terminalHandle: null } }
    : undefined
}

function viewLocation(target: AgentMessageSenderTarget | undefined, activity = true) {
  if (target?.kind === 'legacy') {
    return (
      target.location && { ...target.location, ...(!activity ? { activity: false as const } : {}) }
    )
  }
  const located = target?.kind === 'located' ? target.location : undefined
  return (
    located && {
      ...located,
      agentType: located.tab?.agentSessionAgent,
      ...(!activity ? { activity: false as const } : {})
    }
  )
}

/** The card's sender, rebuilt only from the fields resolution reads, and where it runs now. */
function useSenderLocation(
  sender: AgentMessageSender | undefined,
  chatWorktreeId: string | null,
  target: RuntimeClientTarget | undefined,
  dispatchId: string | undefined
) {
  const address = sender?.party.address
  const sessionId = sender?.party.orcaSessionId
  const handle = sender?.party.terminalHandle
  const savedAgent = agentMessageSavedKind(sender)
  const targetKind = target?.kind
  const environmentId = target?.kind === 'environment' ? target.environmentId : undefined
  const stableTarget = useMemo<RuntimeClientTarget | undefined>(
    () =>
      targetKind === 'local'
        ? { kind: 'local' }
        : environmentId !== undefined
          ? { kind: 'environment', environmentId }
          : undefined,
    [targetKind, environmentId]
  )
  const identity = useMemo<AgentMessageSender | undefined>(
    () =>
      address
        ? {
            party: { address, orcaSessionId: sessionId ?? null, terminalHandle: handle ?? null },
            name: null,
            ...(savedAgent ? { agent: savedAgent } : {})
          }
        : undefined,
    [address, sessionId, handle, savedAgent]
  )
  const resolve = useCallback(
    (state: AppState) =>
      identity
        ? resolveAgentMessageSenderTarget(state, identity, chatWorktreeId, stableTarget, dispatchId)
        : undefined,
    [identity, chatWorktreeId, stableTarget, dispatchId]
  )
  const activity = useMemo(() => activitySender(identity, dispatchId), [identity, dispatchId])
  const locate = useCallback(
    (state: AppState) => {
      const resolved = activity
        ? resolveAgentMessageSenderTarget(state, activity, chatWorktreeId, stableTarget, undefined)
        : undefined
      return viewLocation(resolved) ?? viewLocation(resolve(state), false)
    },
    [activity, chatWorktreeId, stableTarget, resolve]
  )
  // The kind check reads the candidate's row before it can veto it, so the card leases that row's
  // source in every answer: a replaced card reuses it as a located one does.
  const leaseLocate = useCallback(
    (state: AppState) =>
      identity
        ? agentMessageSenderCandidateLocation(
            state,
            identity,
            chatWorktreeId,
            stableTarget,
            dispatchId
          )
        : undefined,
    [identity, chatWorktreeId, stableTarget, dispatchId]
  )
  const activityLeaseLocate = useCallback(
    (state: AppState) =>
      (activity
        ? agentMessageSenderCandidateLocation(
            state,
            activity,
            chatWorktreeId,
            stableTarget,
            undefined
          )
        : undefined) ?? leaseLocate(state),
    [activity, chatWorktreeId, stableTarget, leaseLocate]
  )
  return { identity, savedAgent, resolve, locate, leaseLocate, activityLeaseLocate }
}

export function useAgentMessageSenderView(
  sender: AgentMessageSender | undefined,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget,
  dispatchId?: string
) {
  const { savedAgent, locate, activityLeaseLocate } = useSenderLocation(
    sender,
    chatWorktreeId,
    target,
    dispatchId
  )
  return useAgentMessageSenderSource(locate, savedAgent, activityLeaseLocate)
}

/** Whether the card's sender name is a link. Its kind check reads the located row, so it holds
 *  the same lease the avatar does: a name drawn without an avatar rebuilds no rows per write. */
export function useAgentMessageSenderOpens(
  sender: AgentMessageSender,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget,
  dispatchId?: string
): boolean {
  const { identity, resolve, leaseLocate } = useSenderLocation(
    sender,
    chatWorktreeId,
    target,
    dispatchId
  )
  const opens = useCallback(
    (state: AppState) => {
      const resolved = resolve(state)
      return Boolean(resolved && identity && agentMessageSenderOpens(resolved, identity))
    },
    [resolve, identity]
  )
  return useLeasedSenderSelector(leaseLocate, opens)
}

export type AgentMessageSenderInput = {
  sender: AgentMessageSender | undefined
  worktreeId: string | null
}

/** List form of the card avatar's view: one subscription for every sender in `inputs`. */
export function useAgentMessageSenderViews(
  inputs: readonly AgentMessageSenderInput[],
  target?: RuntimeClientTarget
) {
  const targetKind = target?.kind
  const environmentId = target?.kind === 'environment' ? target.environmentId : undefined
  const lookups = useMemo(() => {
    const stable: RuntimeClientTarget | undefined =
      targetKind === 'local'
        ? { kind: 'local' }
        : environmentId !== undefined
          ? { kind: 'environment', environmentId }
          : undefined
    return inputs.map(({ sender, worktreeId }) => ({
      locate: (state: AppState) => {
        const resolved = sender
          ? resolveAgentMessageSenderTarget(state, sender, worktreeId, stable, undefined)
          : undefined
        if (resolved?.kind === 'legacy') {
          return resolved.location
        }
        const located = resolved?.kind === 'located' ? resolved.location : undefined
        return located && { ...located, agentType: located.tab?.agentSessionAgent }
      },
      leaseLocate: (state: AppState) =>
        sender
          ? agentMessageSenderCandidateLocation(state, sender, worktreeId, stable, undefined)
          : undefined,
      savedAgent: agentMessageSavedKind(sender)
    }))
  }, [inputs, targetKind, environmentId])
  return useAgentMessageSenderSources(lookups)
}
