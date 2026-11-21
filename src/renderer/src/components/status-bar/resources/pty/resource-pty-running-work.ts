import { isShellProcess } from '../../../../../../shared/agent-status/process/shell-process-detection'
import { waitForPromiseWithSignal } from '../../../../../../shared/concurrency/abort-signal-reason'
import { mapWithConcurrency } from '../../../../../../shared/concurrency/map-with-concurrency'
import { PrioritySemaphore } from '../../../../../../shared/concurrency/priority-semaphore'
import { isClientOnlyUnverifiableInspection } from '../../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import type { ResourcePtyRow } from './resource-pty-view-model'

const MAX_CONCURRENT_INSPECTIONS = 4
const WORKSPACE_END_CHECK_TIMEOUT_MS = 4_000
const inspectionSlots = new PrioritySemaphore(MAX_CONCURRENT_INSPECTIONS)

export type ResourcePtyRunningWork = 'running' | 'idle' | 'unverifiable'

async function inspectRunningWork(
  row: ResourcePtyRow,
  signal: AbortSignal
): Promise<ResourcePtyRunningWork> {
  const { id, incarnationId, agentOwnership } = row.session
  if (agentOwnership === 'present') {
    return 'running'
  }
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
        scanChildProcesses: true
      })
      if (isClientOnlyUnverifiableInspection(inspection)) {
        return 'unverifiable'
      }
      const evidence = inspection.foregroundProcessEvidence
      if (evidence?.ptyIncarnationId !== incarnationId) {
        return 'unverifiable'
      }
      if (evidence.verdict === 'exited') {
        return 'idle'
      }
      const process = inspection.foregroundProcess?.trim()
      if (inspection.childProcessEvidence === 'children' || (process && !isShellProcess(process))) {
        return 'running'
      }
      if (
        inspection.childProcessEvidence === 'no-children' &&
        (evidence.verdict === 'live' || evidence.reason === 'windows_ssh_foreground_unavailable')
      ) {
        return 'idle'
      }
    } finally {
      release()
    }
  } catch {
    // Lost or unsupported inspection is indistinguishable from live work here.
  }
  return 'unverifiable'
}

export async function checkResourcePtysRunningWork(
  rows: readonly ResourcePtyRow[],
  cancellation: AbortSignal
): Promise<ReadonlyMap<string, ResourcePtyRunningWork>> {
  const signal = AbortSignal.any([
    cancellation,
    AbortSignal.timeout(WORKSPACE_END_CHECK_TIMEOUT_MS)
  ])
  const observed = new Map<string, ResourcePtyRunningWork>()
  const scan = mapWithConcurrency(rows, MAX_CONCURRENT_INSPECTIONS, async (row) => {
    if (!signal.aborted) {
      const work = await inspectRunningWork(row, signal)
      if (!signal.aborted) {
        observed.set(row.identity, work)
      }
    }
  })
  await waitForPromiseWithSignal(scan, signal).catch(() => undefined)
  return observed
}
