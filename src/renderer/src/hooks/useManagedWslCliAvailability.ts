import { useEffect, useState } from 'react'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

type Availability = {
  target: RuntimeClientTarget | null
  distro: string | undefined
  enabled: boolean
  available: boolean
}

export function useManagedWslCliAvailability(
  target: RuntimeClientTarget | null,
  enabled: boolean,
  wslDistro?: string | null
): boolean {
  const distro = wslDistro?.trim() || undefined
  const [result, setResult] = useState<Availability>({ target, distro, enabled, available: false })
  const matches = result.target === target && result.distro === distro && result.enabled === enabled
  if (!matches) {
    setResult({ target, distro, enabled, available: false })
  }
  useEffect(() => {
    if (!enabled || !target) {
      return
    }
    let cancelled = false
    void callRuntimeRpc<boolean>(
      target,
      'host.wsl.managedCliAvailable',
      { distro },
      { timeoutMs: 15_000 }
    )
      .catch(() => false)
      .then((available) => {
        if (!cancelled) {
          setResult({ target, distro, enabled, available: available === true })
        }
      })
    return () => {
      cancelled = true
    }
  }, [target, enabled, distro])
  // A previous host or distro's proof must never suppress this target's setup.
  return enabled && matches && result.available
}
