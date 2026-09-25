import { runWithGitOperationLock } from './git-operation-lock'
import {
  gitCommonDirLockKey,
  locateGitSubcommand,
  resolveCanonicalGitCommonDir
} from './git-common-dir-location'

type GitFetchHeadCommand = { needsLock: boolean; cwd: string; gitDir?: string }

export function resolveGitFetchHeadCommand(
  args: readonly string[],
  initialCwd: string
): GitFetchHeadCommand {
  const { cwd, gitDir, subcommandIndex } = locateGitSubcommand(args, initialCwd)
  const subcommand = args[subcommandIndex]
  if (subcommand === 'pull') {
    return { needsLock: true, cwd, gitDir }
  }
  if (subcommand !== 'fetch') {
    return { needsLock: false, cwd, gitDir }
  }
  let writesFetchHead = true
  let updatesRemoteTrackingRef = false
  for (const arg of args.slice(subcommandIndex + 1)) {
    if (arg === '--no-write-fetch-head') {
      writesFetchHead = false
    } else if (arg === '--write-fetch-head') {
      writesFetchHead = true
    } else if (arg.includes(':refs/remotes/')) {
      updatesRemoteTrackingRef = true
    }
  }
  // Why: explicit tracking-ref updates race sibling-worktree fetch transactions even without FETCH_HEAD.
  return { needsLock: writesFetchHead || updatesRemoteTrackingRef, cwd, gitDir }
}

export async function runWithGitFetchHeadLock<T>(
  worktreePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  explicitGitDir?: string
): Promise<T> {
  const { commonDir } = await resolveCanonicalGitCommonDir(worktreePath, signal, explicitGitDir)
  return runWithGitOperationLock(gitCommonDirLockKey(commonDir, 'FETCH_HEAD'), signal, run)
}
