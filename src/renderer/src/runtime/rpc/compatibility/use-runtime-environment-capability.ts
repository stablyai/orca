import { useEffect, useState } from 'react'
import type { RuntimeCapability } from '../../../../../shared/remote-runtime/protocol/protocol-version'
import { subscribeRuntimeHostContactRegained } from '../../hosts/connections/runtime-host-contact-regained'
import { runtimeEnvironmentSupportsCapability } from './runtime-capability-proof'

/** What the paired runtime said about a capability: `unknown` until it answers, when it couldn't, and
 *  again after the client reconnects, since a reconnect may reach another runtime. */
export type RuntimeCapabilityAnswer = 'unknown' | 'supported' | 'unsupported'

/** The runtime's answer about a capability; `unknown` while no runtime is given. */
export function useRuntimeEnvironmentCapabilityAnswer(
  environmentId: string | null | undefined,
  capability: RuntimeCapability
): RuntimeCapabilityAnswer {
  const [contactGeneration, setContactGeneration] = useState(0)
  const key = environmentId ? `${environmentId}\n${capability}\n${contactGeneration}` : null
  const [answer, setAnswer] = useState<{ key: string; answer: RuntimeCapabilityAnswer } | null>(
    null
  )
  useEffect(() => {
    if (!environmentId) {
      return
    }
    return subscribeRuntimeHostContactRegained(environmentId, () =>
      setContactGeneration((generation) => generation + 1)
    )
  }, [environmentId])
  useEffect(() => {
    if (!environmentId || !key) {
      return
    }
    let cancelled = false
    void runtimeEnvironmentSupportsCapability(environmentId, capability)
      .then((supported) => {
        if (!cancelled) {
          setAnswer({ key, answer: supported ? 'supported' : 'unsupported' })
        }
      })
      .catch(() => {
        // No answer (unreachable, timed out) says nothing about the runtime's version.
        if (!cancelled) {
          setAnswer({ key, answer: 'unknown' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [environmentId, capability, key])
  return answer?.key === key ? answer.answer : 'unknown'
}

/** Whether the paired runtime advertises a capability; false until it answers, while no runtime is given, and again after the client reconnects, since a reconnect may reach another runtime. */
export function useRuntimeEnvironmentCapability(
  environmentId: string | null | undefined,
  capability: RuntimeCapability
): boolean {
  return useRuntimeEnvironmentCapabilityAnswer(environmentId, capability) === 'supported'
}
