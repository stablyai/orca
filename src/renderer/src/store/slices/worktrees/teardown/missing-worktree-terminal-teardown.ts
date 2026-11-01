import { callRuntimeRpc } from '../../../../runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import { isRuntimeMethodNotFoundError } from '../listing/runtime-worktree-rpc-errors'

// Scan coalescing cannot share caller-specific purge snapshots; deduplicate identical teardown requests instead (#10562).
const missingWorktreeTeardownsInFlight = new Map<string, Promise<void>>()

export async function teardownMissingWorktreeTerminalsBestEffort(
  /** The host whose listing found the worktrees missing. */
  target: RuntimeClientTarget,
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
