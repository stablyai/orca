import type { Repo } from '../../../../shared/repo-types'
import { syncRuntimeGitForkDefaultBranch } from '../../runtime/runtime-git-sync-client'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getRepoMainWorktreeId } from '../../../../shared/worktree/id'
import { ipcOrRuntimeTargetForHostId } from '../../runtime/runtime-client-target'

export const SAFE_AUTO_FORK_SYNC_COOLDOWN_MS = 10 * 60 * 1000

export const safeAutoForkSyncAttempts = new Map<
  string,
  { attemptedAt: number; promise?: Promise<void> }
>()
const MAX_SAFE_AUTO_FORK_SYNC_ATTEMPTS = 512

function pruneSafeAutoForkSyncAttempts(now: number): void {
  for (const [key, attempt] of safeAutoForkSyncAttempts) {
    if (!attempt.promise && now - attempt.attemptedAt >= SAFE_AUTO_FORK_SYNC_COOLDOWN_MS) {
      safeAutoForkSyncAttempts.delete(key)
    }
  }
  while (safeAutoForkSyncAttempts.size > MAX_SAFE_AUTO_FORK_SYNC_ATTEMPTS) {
    const oldest = safeAutoForkSyncAttempts.keys().next()
    if (oldest.done) {
      return
    }
    safeAutoForkSyncAttempts.delete(oldest.value)
  }
}

export function getSafeAutoForkSyncKey(repo: Repo): string {
  return `${getRepoExecutionHostId(repo)}:${repo.id}:${repo.path}`
}

export function scheduleSafeAutoForkSync(repos: readonly Repo[]): void {
  const now = Date.now()
  pruneSafeAutoForkSyncAttempts(now)
  for (const repo of repos) {
    if (repo.kind === 'folder' || repo.forkSyncMode !== 'safe-auto' || !repo.upstream) {
      continue
    }
    const key = getSafeAutoForkSyncKey(repo)
    const existingAttempt = safeAutoForkSyncAttempts.get(key)
    if (
      existingAttempt?.promise ||
      (existingAttempt && now - existingAttempt.attemptedAt < SAFE_AUTO_FORK_SYNC_COOLDOWN_MS)
    ) {
      continue
    }
    const target = ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo))
    if (!target) {
      continue
    }
    const promise = syncRuntimeGitForkDefaultBranch(
      {
        target,
        worktreeId: getRepoMainWorktreeId(repo),
        worktreePath: repo.path,
        connectionId: repo.connectionId ?? undefined
      },
      repo.upstream
    )
      .then(() => undefined)
      .catch((error) => {
        // Why: safe-auto is opportunistic; auth/protection/divergence failures shouldn't add startup noise (Sync Now handles explicit diagnosis).
        console.info('Safe fork auto-sync skipped', error)
      })
      .finally(() => {
        const current = safeAutoForkSyncAttempts.get(key)
        if (current?.promise === promise) {
          safeAutoForkSyncAttempts.set(key, { attemptedAt: now })
        }
      })
    safeAutoForkSyncAttempts.set(key, { attemptedAt: now, promise })
  }
  pruneSafeAutoForkSyncAttempts(now)
}
