import { useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  readRuntimeHostResources,
  withRuntimeHostResult,
  type RuntimeHostResourceResult,
  type RuntimeHostResourceState
} from './runtime-host-resources'

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
  const [state, setState] = useState<RuntimeHostResourceState>({ key: null, results: {} })

  useEffect(() => {
    if (sessionKey === null || sessionKey === '') {
      return
    }
    let cancelled = false
    const inFlight = new Set<string>()
    const misses = new Map<string, number>()
    const poll = (): void => {
      for (const environmentId of sessionKey.split('\n')) {
        // Why: a slow server must not stack requests or delay another server's sample.
        if (inFlight.has(environmentId)) {
          continue
        }
        inFlight.add(environmentId)
        void readRuntimeHostResources(environmentId, callDiagnosticsMemory, () => !cancelled).then(
          (result) => {
            inFlight.delete(environmentId)
            if (result === null) {
              return
            }
            const missed =
              result.status === 'unreachable' ? (misses.get(environmentId) ?? 0) + 1 : 0
            misses.set(environmentId, missed)
            if (!cancelled) {
              setState((prev) =>
                // One slow answer keeps a shown sample; with nothing shown yet, the failure shows now.
                missed === 1 &&
                prev.key === sessionKey &&
                prev.results[environmentId]?.status === 'sampled'
                  ? prev
                  : withRuntimeHostResult(prev, sessionKey, environmentId, result)
              )
            }
          }
        )
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
