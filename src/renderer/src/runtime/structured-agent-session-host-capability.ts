import { useEffect, useState } from 'react'
import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import type { RuntimeClientTarget } from './runtime-client-target'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from './local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

export function structuredAgentSessionHostKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

/** Whether the session's host advertises `capability`. False until the host has said so, and for
 *  a failed probe: an older host is handled as it always was. */
export function useStructuredAgentSessionHostCapability(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): boolean {
  const key = structuredAgentSessionHostKey(target)
  const [answer, setAnswer] = useState<{ key: string; supported: boolean }>(() => ({
    key,
    supported:
      target.kind === 'local' &&
      (readLocalRuntimeCapabilitiesOrUnknown()?.includes(capability) ?? false)
  }))
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  useEffect(() => {
    let cancelled = false
    const probe =
      environmentId === null
        ? ensureLocalRuntimeCapabilities().then(
            (capabilities) => capabilities?.includes(capability) ?? false
          )
        : runtimeEnvironmentSupportsCapability(environmentId, capability)
    void probe
      .catch(() => false)
      .then((supported) => {
        if (!cancelled) {
          setAnswer((current) =>
            current.key === key && current.supported === supported ? current : { key, supported }
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [capability, environmentId, key])
  return answer.key === key && answer.supported
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
