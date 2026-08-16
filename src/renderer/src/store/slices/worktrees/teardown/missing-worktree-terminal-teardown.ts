import { callRuntimeRpc, getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import type { AppState } from '../../../types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import { isRuntimeMethodNotFoundError } from '../listing/runtime-worktree-rpc-errors'

// Why: teardown cannot ride the scan's coalescing (each caller has its own known-id
// snapshot), so dedupe on the request it actually produces — identical fan-out
// requests share one host sweep instead of re-scanning per caller.
const missingWorktreeTeardownsInFlight = new Map<string, Promise<void>>()

export async function teardownMissingWorktreeTerminalsBestEffort(
  settings: AppState['settings'],
  repoId: string,
  connectionId: string | null | undefined,
  // Why: refreshes that never purge omit this; an absent snapshot means
  // "nothing to reconcile", never "purge everything".
  knownWorktreeIds: readonly string[] | undefined,
  detected: DetectedWorktreeListResult
): Promise<void> {
  if (!detected.authoritative || !knownWorktreeIds || knownWorktreeIds.length === 0) {
    return
  }
  const detectedIds = new Set(detected.worktrees.map((worktree) => worktree.id))
  const missingIds = knownWorktreeIds.filter((worktreeId) => !detectedIds.has(worktreeId))
  if (missingIds.length === 0) {
    return
  }
  const target = getActiveRuntimeTarget(settings)
  const normalizedConnectionId = connectionId ?? null
  const key = [
    target.kind === 'local' ? 'local' : `runtime:${target.environmentId}`,
    repoId,
    normalizedConnectionId ?? '',
    [...missingIds].sort().join('\n')
  ].join('\0')
  const existing = missingWorktreeTeardownsInFlight.get(key)
  if (existing) {
    return existing
  }
  const teardown = (async () => {
    try {
      await callRuntimeRpc(
        target,
        'worktree.teardownMissingTerminals',
        { repo: repoId, worktreeIds: missingIds, connectionId: normalizedConnectionId },
        { timeoutMs: 30_000 }
      )
    } catch (error) {
      if (!isRuntimeMethodNotFoundError(error)) {
        console.warn(`Failed to stop terminals for missing worktrees in repo ${repoId}:`, error)
      }
    }
  })()
  missingWorktreeTeardownsInFlight.set(key, teardown)
  try {
    await teardown
  } finally {
    if (missingWorktreeTeardownsInFlight.get(key) === teardown) {
      missingWorktreeTeardownsInFlight.delete(key)
    }
  }
}
