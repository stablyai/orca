import { useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { readRuntimeHostResources, type RuntimeHostResourceResult } from './runtime-host-resources'

const RUNTIME_RESOURCE_TIMEOUT_MS = 5_000
const EMPTY_RESULTS: Readonly<Record<string, RuntimeHostResourceResult>> = {}

function callDiagnosticsMemory(environmentId: string): Promise<unknown> {
  return callRuntimeRpc<unknown>(
    { kind: 'environment', environmentId },
    'diagnostics.memory',
    undefined,
    {
      timeoutMs: RUNTIME_RESOURCE_TIMEOUT_MS,
      reuseRecentCompatibilityFailure: true
    }
  )
}

/** Polls each paired server's own process samples while the Resource Manager is open. */
export function useRuntimeHostResources(
  open: boolean,
  environmentIds: readonly string[],
  pollMs: number
): Readonly<Record<string, RuntimeHostResourceResult>> {
  const environmentKey = environmentIds.join('\n')
  const sessionKey = open ? environmentKey : null
  // Why keyed and reset on cleanup: a reopened panel or changed host set never shows old samples.
  const [state, setState] = useState<{
    key: string | null
    results: Readonly<Record<string, RuntimeHostResourceResult>>
  }>({ key: null, results: {} })

  useEffect(() => {
    if (sessionKey === null || sessionKey === '') {
      return
    }
    let cancelled = false
    const inFlight = new Set<string>()
    const poll = (): void => {
      for (const environmentId of sessionKey.split('\n')) {
        // Why: a slow server must not stack requests or delay another server's sample.
        if (inFlight.has(environmentId)) {
          continue
        }
        inFlight.add(environmentId)
        void readRuntimeHostResources(environmentId, callDiagnosticsMemory).then((result) => {
          inFlight.delete(environmentId)
          if (!cancelled) {
            setState((prev) => ({
              key: sessionKey,
              results: { ...(prev.key === sessionKey ? prev.results : {}), [environmentId]: result }
            }))
          }
        })
      }
    }
    poll()
    const timer = window.setInterval(poll, pollMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      setState({ key: null, results: {} })
    }
  }, [sessionKey, pollMs])

  return state.key === sessionKey && sessionKey !== null ? state.results : EMPTY_RESULTS
}
