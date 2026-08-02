import { useEffect, useRef, useState } from 'react'
import type { OrchestrationCostReport } from '../../../../shared/orchestration-cost-report'
import {
  callRuntimeRpc,
  hasRuntimeRpcErrorCode,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'

const CLOSED_POLL_MS = 15_000
const OPEN_POLL_MS = 5_000

export type OrchestrationReportLoadError = 'older-runtime' | 'run-not-found' | 'runtime'

type ReportLoadState = {
  key: string
  report: OrchestrationCostReport | null
  error: OrchestrationReportLoadError | null
  stale: boolean
  refreshing: boolean
}

function requestKey(target: RuntimeClientTarget, runId: string | null): string {
  const targetKey = target.kind === 'environment' ? `environment:${target.environmentId}` : 'local'
  return `${targetKey}:${runId ?? 'none'}`
}

function classifyReportError(error: unknown): OrchestrationReportLoadError {
  if (
    hasRuntimeRpcErrorCode(error, 'method_not_found') ||
    hasRuntimeRpcErrorCode(error, 'unknown_method')
  ) {
    return 'older-runtime'
  }
  return hasRuntimeRpcErrorCode(error, 'run_not_found') ? 'run-not-found' : 'runtime'
}

export function useOrchestrationCostReport(
  target: RuntimeClientTarget,
  runId: string | null,
  open: boolean
): ReportLoadState {
  const key = requestKey(target, runId)
  const sequenceRef = useRef(0)
  const [state, setState] = useState<ReportLoadState>({
    key,
    report: null,
    error: null,
    stale: false,
    refreshing: false
  })

  useEffect(() => {
    const sequence = ++sequenceRef.current
    const controller = new AbortController()
    let inFlight = false
    setState((current) =>
      current.key === key
        ? { ...current, refreshing: Boolean(runId) }
        : { key, report: null, error: null, stale: false, refreshing: Boolean(runId) }
    )
    if (!runId) {
      return () => controller.abort()
    }

    const refresh = async (allowHidden: boolean): Promise<void> => {
      if (inFlight || (!allowHidden && document.visibilityState === 'hidden')) {
        return
      }
      inFlight = true
      setState((current) => (current.key === key ? { ...current, refreshing: true } : current))
      try {
        const report = await callRuntimeRpc<OrchestrationCostReport>(
          target,
          'orchestration.report',
          { id: runId },
          { signal: controller.signal, timeoutMs: 10_000, reuseRecentCompatibilityFailure: true }
        )
        if (sequence === sequenceRef.current && !controller.signal.aborted) {
          setState({ key, report, error: null, stale: false, refreshing: false })
        }
      } catch (error) {
        if (
          sequence === sequenceRef.current &&
          !controller.signal.aborted &&
          !(error instanceof Error && error.name === 'AbortError')
        ) {
          const classified = classifyReportError(error)
          setState((current) => {
            if (current.key !== key) {
              return current
            }
            const keepReport = classified === 'runtime' ? current.report : null
            return {
              key,
              report: keepReport,
              error: classified,
              stale: keepReport !== null,
              refreshing: false
            }
          })
        }
      } finally {
        inFlight = false
      }
    }

    void refresh(true)
    const interval = window.setInterval(
      () => void refresh(false),
      open ? OPEN_POLL_MS : CLOSED_POLL_MS
    )
    const refreshWhenVisible = (): void => {
      if (document.visibilityState !== 'hidden') {
        void refresh(true)
      }
    }
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      sequenceRef.current += 1
      controller.abort()
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [key, open, runId, target])

  return state.key === key
    ? state
    : { key, report: null, error: null, stale: false, refreshing: Boolean(runId) }
}
