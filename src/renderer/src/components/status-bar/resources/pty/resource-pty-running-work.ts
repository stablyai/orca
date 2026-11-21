import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import { waitForPromiseWithSignal } from '../../../../../../shared/concurrency/abort-signal-reason'
import { PrioritySemaphore } from '../../../../../../shared/concurrency/priority-semaphore'
import type { PtyRunningWorkObservation } from '../../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import type { ResourcePtyRow } from './resource-pty-view-model'

const MAX_CONCURRENT_INSPECTIONS = 4
const WORKSPACE_END_CHECK_TIMEOUT_MS = 4_000
const inspectionSlots = new PrioritySemaphore(MAX_CONCURRENT_INSPECTIONS)

async function inspectRunningWork(
  row: ResourcePtyRow,
  runningWorkSinceMs: number,
  runningWorkCheckId: string,
  signal: AbortSignal
): Promise<PtyRunningWorkObservation> {
  const { id, incarnationId } = row.session
  if (!incarnationId || signal.aborted) {
    return 'unverifiable'
  }
  try {
    const release = await inspectionSlots.acquire(0, signal)
    try {
      if (signal.aborted) {
        return 'unverifiable'
      }
      const inspection = await window.api.pty.inspectProcess(id, {
        expectedIncarnationId: incarnationId,
        runningWorkSinceMs,
        runningWorkCheckId
      })
      return inspection.runningWork ?? 'unverifiable'
    } finally {
      release()
    }
  } catch {
    return 'unverifiable'
  }
}

export async function checkResourcePtysRunningWork(
  rows: readonly ResourcePtyRow[],
  cancellation: AbortSignal
): Promise<ReadonlyMap<string, PtyRunningWorkObservation>> {
  const runningWorkSinceMs = Date.now()
  const runningWorkCheckId = createBrowserUuid()
  const signal = AbortSignal.any([
    cancellation,
    AbortSignal.timeout(WORKSPACE_END_CHECK_TIMEOUT_MS)
  ])
  const cancel = () => window.api.pty.cancelRunningWorkCheck(runningWorkCheckId)
  signal.addEventListener('abort', cancel, { once: true })
  const observed = new Map<string, PtyRunningWorkObservation>()
  const pending = rows.values()
  const inspect = async (): Promise<void> => {
    while (!signal.aborted) {
      const next = pending.next()
      if (next.done) {
        return
      }
      const row = next.value
      const work = await inspectRunningWork(row, runningWorkSinceMs, runningWorkCheckId, signal)
      if (!signal.aborted) {
        observed.set(row.identity, work)
      }
    }
  }
  const scan = Promise.all(
    Array.from({ length: Math.min(rows.length, MAX_CONCURRENT_INSPECTIONS) }, inspect)
  )
  await waitForPromiseWithSignal(scan, signal).catch(() => undefined)
  signal.removeEventListener('abort', cancel)
  return observed
}

export function useResourcePtyWorkspaceCheck(
  active: boolean,
  onChecked: (
    rows: readonly ResourcePtyRow[],
    observations: ReadonlyMap<string, PtyRunningWorkObservation>
  ) => void
) {
  const [checkingGroup, setCheckingGroup] = useState<string | null>(null)
  const check = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    return active ? () => check.current?.abort() : undefined
  }, [active])
  const start = useCallback(
    (group: string, targets: readonly ResourcePtyRow[]) => {
      if (check.current || targets.length === 0) {
        return
      }
      const controller = new AbortController()
      check.current = controller
      setCheckingGroup(group)
      void checkResourcePtysRunningWork(targets, controller.signal).then((observations) => {
        check.current = null
        setCheckingGroup(null)
        if (!controller.signal.aborted) {
          onChecked(targets, observations)
        }
      })
    },
    [onChecked]
  )
  return { checkingGroup, start }
}
