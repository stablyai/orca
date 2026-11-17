import { useEffect, useState } from 'react'
import type { RuntimeCapability } from '../../../../../shared/remote-runtime/protocol/protocol-version'
import { runtimeEnvironmentSupportsCapability } from './runtime-capability-proof'

/** Whether the paired runtime advertises a capability; false until it answers, and while no runtime is given. */
export function useRuntimeEnvironmentCapability(
  environmentId: string | null | undefined,
  capability: RuntimeCapability
): boolean {
  const key = environmentId ? `${environmentId}\n${capability}` : null
  const [answer, setAnswer] = useState<{ key: string; supported: boolean } | null>(null)
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
