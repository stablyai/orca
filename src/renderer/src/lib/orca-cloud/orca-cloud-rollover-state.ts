// Session rollovers (24h cap or "Restart now") run in main without a wake step; this maps their
// state events onto the store's wake entries so the sidebar mark and panel show "Restarting".
import { noteCloudWakeProgress } from './orca-cloud-workspace-store'

const rolloverStarts = new Map<string, number>()

/**
 * A session rollover (24h cap or "Restart now") runs in main without a wake step, so the sidebar
 * mark and status panel learn about it here: restarting is a wake from source `restart`.
 */
export function noteCloudRolloverState(
  workspaceId: string,
  state: 'restarting' | 'running' | 'restart-failed'
): void {
  if (state === 'restarting') {
    const startedAt = Date.now()
    rolloverStarts.set(workspaceId, startedAt)
    noteCloudWakeProgress({
      workspaceId,
      phase: 'waking',
      source: 'restart',
      startedAt,
      at: startedAt
    })
    return
  }
  const startedAt = rolloverStarts.get(workspaceId)
  rolloverStarts.delete(workspaceId)
  if (startedAt === undefined) {
    return
  }
  noteCloudWakeProgress({
    workspaceId,
    phase: state === 'running' ? 'ready' : 'failed',
    source: 'restart',
    startedAt,
    at: Date.now()
  })
}
