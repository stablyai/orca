import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runWithGitOperationLock } from './git-operation-lock'

/** Serialize mutations that leave per-worktree state in progress (for example, rebase). */
export async function runWithGitWorktreeOperationLock<T>(
  worktreePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  const key = await realpath(worktreePath).catch(() => resolve(worktreePath))
  return runWithGitOperationLock(key, signal, run)
}
