import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runWithGitOperationLock } from './git-operation-lock'

/** Serialize mutations that leave per-worktree state in progress (for example, rebase). */
export async function runWithGitWorktreeOperationLock<T>(
  worktreePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  const fallbackKey = resolve(worktreePath)
  // Why: back-to-back callers (stage, then commit) must join the canonical lane in call order.
  // realpath is async and unordered, so sequence it under a lane keyed by the raw path, which
  // needs no I/O. realpath stays async because a hung 9P/UNC lookup must not block the process.
  return runWithGitOperationLock(`order\0${fallbackKey}`, signal, async () => {
    let key = fallbackKey
    try {
      key = (await realpath(worktreePath)) || fallbackKey
    } catch {
      // A missing or temporarily unreachable worktree still gets serialized.
    }
    return runWithGitOperationLock(key, signal, run)
  })
}
