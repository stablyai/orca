import type { GitCapabilityCache } from '../git-capability-cache'

export type SplitWorktreeAddGitOptions = {
  worktreeAdminLock?: false
  /** Replaces the caller's own per-command timeout. */
  timeout?: number
  /** Runs without the create's AbortSignal, so cleanup still happens after a cancel. */
  detached?: true
}

export type SplitWorktreeAddGit = (
  args: string[],
  cwd: string,
  options?: SplitWorktreeAddGitOptions
) => Promise<{ stdout: string }>

export type SplitWorktreeAddRequest = {
  repoPath: string
  worktreePath: string
  /** Global options such as `-c core.longpaths=true`, placed before every subcommand. */
  globalArgs: string[]
  /** Everything after `worktree add`, without `--no-checkout`. */
  addArgs: string[]
  git: SplitWorktreeAddGit
  capabilities: GitCapabilityCache
  /** One budget shared by every step, so the split add is bounded like the plain command. */
  timeoutMs?: number
  /** Runs once Git has written the new worktree's `.git` marker, even if the add then fails. */
  afterAdminWrite?: () => void
}

const HOOK_RUN_PROBE_NAME = 'orca-capability-probe'
export const SPLIT_WORKTREE_ADD_CLEANUP_TIMEOUT_MS = 60_000

type StepGit = (args: string[], cwd: string) => Promise<{ stdout: string }>

function withSharedDeadline(git: SplitWorktreeAddGit, timeoutMs: number | undefined): StepGit {
  if (timeoutMs === undefined) {
    return (args, cwd) => git(args, cwd)
  }
  const deadline = Date.now() + timeoutMs
  return (args, cwd) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return Promise.reject(
        Object.assign(new Error(`git worktree add timed out after ${timeoutMs} ms`), {
          code: 'ETIMEDOUT'
        })
      )
    }
    return git(args, cwd, { timeout: remaining })
  }
}

function isHookRunUnsupportedError(error: unknown): boolean {
  const text = [
    error instanceof Error ? error.message : String(error),
    typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : ''
  ].join('\n')
  return /is not a git command|unknown (sub)?command|unknown option|usage: git hook/i.test(text)
}

async function supportsHookRun(request: SplitWorktreeAddRequest, git: StepGit): Promise<boolean> {
  const { capabilities, globalArgs, repoPath } = request
  if (capabilities.isKnownSupported('hook-run')) {
    return true
  }
  if (!capabilities.shouldTry('hook-run')) {
    return false
  }
  try {
    await git([...globalArgs, 'hook', 'run', '--ignore-missing', HOOK_RUN_PROBE_NAME], repoPath)
    capabilities.rememberSupported('hook-run')
    return true
  } catch (error) {
    if (isHookRunUnsupportedError(error)) {
      capabilities.rememberUnsupported('hook-run')
    }
    return false
  }
}

/**
 * `git worktree add` with only the admin write inside the repo's admin lock.
 *
 * Why: the plain command checks out every file and runs post-checkout while it
 * holds that lock, so one slow checkout stalls every other create in the repo.
 * Here the admin write runs with `--no-checkout`, then files and the hook run
 * unlocked. The hook keeps the plain command's arguments (null oid, new HEAD,
 * 1); Git before 2.36 has no `git hook run`, so those hosts keep the plain
 * command rather than silently skipping the user's hook.
 */
export async function addWorktreeWithCheckoutOutsideAdminLock(
  request: SplitWorktreeAddRequest
): Promise<void> {
  const { globalArgs, addArgs, repoPath, worktreePath, afterAdminWrite } = request
  const git = withSharedDeadline(request.git, request.timeoutMs)
  const split = await supportsHookRun(request, git)
  try {
    await git(
      [...globalArgs, 'worktree', 'add', ...(split ? ['--no-checkout'] : []), ...addArgs],
      repoPath
    )
  } finally {
    afterAdminWrite?.()
  }
  if (!split) {
    return
  }
  try {
    // Same checkout the plain command runs internally.
    await git([...globalArgs, 'reset', '--hard', '--no-recurse-submodules'], worktreePath)
  } catch (error) {
    // Why: the plain command deletes a worktree whose checkout failed; the branch stays either way.
    // Detached with its own budget: a cancel or an exhausted deadline is the usual reason we are here.
    await request
      .git([...globalArgs, 'worktree', 'remove', '--force', worktreePath], repoPath, {
        worktreeAdminLock: false,
        detached: true,
        timeout: SPLIT_WORKTREE_ADD_CLEANUP_TIMEOUT_MS
      })
      .catch((cleanupError: unknown) => {
        console.warn(
          `[git] could not remove ${worktreePath} after its checkout failed`,
          cleanupError
        )
      })
    throw error
  }
  const head = (await git([...globalArgs, 'rev-parse', 'HEAD'], worktreePath)).stdout.trim()
  // Why: a failing hook keeps the worktree but fails the create, like the plain command.
  await git(
    [
      ...globalArgs,
      'hook',
      'run',
      '--ignore-missing',
      'post-checkout',
      '--',
      '0'.repeat(head.length),
      head,
      '1'
    ],
    worktreePath
  )
}
