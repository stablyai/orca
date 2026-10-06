import { useEffect, useState } from 'react'
import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RECOVERY_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import type { RuntimeClientTarget } from './runtime-client-target'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from './local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'

export function structuredAgentSessionHostKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

/** `unknown` until the host has answered, and after a failed probe: a failed probe is not
 *  evidence about the host. */
export type StructuredAgentSessionHostCapabilityState = 'unknown' | 'supported' | 'unsupported'

/** Whether the session's host advertises `capability`. A failed probe stays `unknown` and a remote
 *  host is asked again each time this client regains contact with it. */
export function useStructuredAgentSessionHostCapabilityState(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): StructuredAgentSessionHostCapabilityState {
  const key = structuredAgentSessionHostKey(target)
  const [answer, setAnswer] = useState<{
    key: string
    state: StructuredAgentSessionHostCapabilityState
  }>(() => ({ key, state: target.kind === 'local' ? localCapabilityState(capability) : 'unknown' }))
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const [contact, setContact] = useState(0)
  useEffect(() => {
    if (environmentId === null) {
      return
    }
    return subscribeRuntimeHostContactRegained(environmentId, () => setContact((n) => n + 1))
  }, [environmentId])
  useEffect(() => {
    let cancelled = false
    const probe: Promise<StructuredAgentSessionHostCapabilityState> =
      environmentId === null
        ? ensureLocalRuntimeCapabilities().then(() => localCapabilityState(capability))
        : runtimeEnvironmentSupportsCapability(environmentId, capability).then((supported) =>
            supported ? 'supported' : 'unsupported'
          )
    void probe
      .catch((): StructuredAgentSessionHostCapabilityState => 'unknown')
      .then((state) => {
        if (!cancelled) {
          setAnswer((current) =>
            current.key === key && current.state === state ? current : { key, state }
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [capability, contact, environmentId, key])
  return answer.key === key ? answer.state : 'unknown'
}

function localCapabilityState(
  capability: RuntimeCapability
): StructuredAgentSessionHostCapabilityState {
  const capabilities = readLocalRuntimeCapabilitiesOrUnknown()
  return capabilities === null
    ? 'unknown'
    : capabilities.includes(capability)
      ? 'supported'
      : 'unsupported'
}

/** Whether the session's host advertises `capability`. False until the host has said so, and for
 *  a failed probe: an older host is handled as it always was. */
export function useStructuredAgentSessionHostCapability(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): boolean {
  return useStructuredAgentSessionHostCapabilityState(target, capability) === 'supported'
}

/** Whether the host takes a Stop naming no turn: the only Stop before the provider opens one. */
export function useStructuredAgentSessionHostStopsConversation(
  target: RuntimeClientTarget
): boolean {
  return useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY
  )
}

/** Whether the host settles a rewind left in doubt on the next send, agent running or not: only
 *  then may a client offer a rewind, which hands an in-doubt prompt back for that send. */
export function useStructuredAgentSessionHostRecoversRewindOnSend(
  target: RuntimeClientTarget
): boolean {
  return useStructuredAgentSessionHostCapability(target, AGENT_SESSION_REWIND_RECOVERY_CAPABILITY)
}

/** Whether the host holds mid-turn sends as drafts: only then may a client send `delivery`. The
 *  published cards and their queuedMessage actions are not gated on it. */
export function useStructuredAgentSessionHostQueuesMessages(target: RuntimeClientTarget): boolean {
  return useStructuredAgentSessionHostQueuesMessagesState(target) === 'supported'
}

/** Three-state, for the outbox: only `supported` lets a first attempt ask to be queued, and only
 *  `unsupported` drops the field from a replay; `unknown` holds nothing back. */
export function useStructuredAgentSessionHostQueuesMessagesState(
  target: RuntimeClientTarget
): StructuredAgentSessionHostCapabilityState {
  return useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
  )
}
