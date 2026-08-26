import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { syncRuntimeGitForkDefaultBranch } from '../../runtime/runtime-git-client'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { settingsForRepoOwner } from './owner-routing'

export const SAFE_AUTO_FORK_SYNC_COOLDOWN_MS = 10 * 60 * 1000

export const safeAutoForkSyncAttempts = new Map<
  string,
  { attemptedAt: number; promise?: Promise<void> }
>()

export function getSafeAutoForkSyncKey(repo: Repo): string {
  return `${getRepoExecutionHostId(repo)}:${repo.id}:${repo.path}`
}

export function scheduleSafeAutoForkSync(get: () => AppState, repos: readonly Repo[]): void {
  for (const repo of repos) {
    if (repo.kind === 'folder' || repo.forkSyncMode !== 'safe-auto' || !repo.upstream) {
      continue
    }
    const key = getSafeAutoForkSyncKey(repo)
    const existingAttempt = safeAutoForkSyncAttempts.get(key)
    const now = Date.now()
    if (
      existingAttempt?.promise ||
      (existingAttempt && now - existingAttempt.attemptedAt < SAFE_AUTO_FORK_SYNC_COOLDOWN_MS)
    ) {
      continue
    }
    const promise = syncRuntimeGitForkDefaultBranch(
      {
        settings: settingsForRepoOwner(get(), repo.id),
        worktreeId: repo.id,
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
}
