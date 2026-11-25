import { useEffect, useState } from 'react'
import type { RuntimeCapability } from '../../../../../shared/remote-runtime/protocol/protocol-version'
import { subscribeRuntimeHostContactRegained } from '../../hosts/connections/runtime-host-contact-regained'
import { runtimeEnvironmentSupportsCapability } from './runtime-capability-proof'

/** Whether the paired runtime advertises a capability; false until it answers, while no runtime is given, and again after the client reconnects, since a reconnect may reach another runtime. */
export function useRuntimeEnvironmentCapability(
  environmentId: string | null | undefined,
  capability: RuntimeCapability
): boolean {
  const [contactGeneration, setContactGeneration] = useState(0)
  const key = environmentId ? `${environmentId}\n${capability}\n${contactGeneration}` : null
  const [answer, setAnswer] = useState<{ key: string; supported: boolean } | null>(null)
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
          setAnswer({ key, supported })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAnswer({ key, supported: false })
        }
      })
    return () => {
      cancelled = true
    }
  }, [environmentId, capability, key])
  return answer?.key === key && answer.supported
}
