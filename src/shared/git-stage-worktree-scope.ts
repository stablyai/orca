import { encodeGitPathspecs } from './git-pathspec-stdin'

/**
 * Host-side "stage everything" for a Source Control listing that hit the status
 * cap: the renderer only holds the first rows, so it cannot name every path.
 * `all` stages tracked and untracked changes; `tracked` stages only tracked ones.
 */
export type GitStageWorktreeScope = 'all' | 'tracked'

/** What a host that ran a scoped stage replies with; a host without scope support replies without it. */
export type GitStageWorktreeScopeReceipt = { stagedScope: GitStageWorktreeScope }

export function parseGitStageWorktreeScope(value: unknown): GitStageWorktreeScope | undefined {
  return value === 'all' || value === 'tracked' ? value : undefined
}

export const GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE =
  'The Orca version running this workspace cannot stage changes beyond the ones listed, so nothing was staged. Update Orca on that host, or stage from a terminal.'

/**
 * Why: an older host strips `scope` and stages only `filePaths`, which scoped callers send empty,
 * so a missing receipt means nothing was staged — never report that as a successful "stage all".
 */
export function requireGitStageWorktreeScopeReceipt(
  reply: unknown,
  scope: GitStageWorktreeScope
): void {
  if (
    typeof reply === 'object' &&
    reply !== null &&
    'stagedScope' in reply &&
    reply.stagedScope === scope
  ) {
    return
  }
  throw new Error(GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE)
}

type GitStageRunner = (args: string[], stdin?: string) => Promise<{ stdout: string }>

export type StageGitWorktreeScopeOptions = {
  /** Untracked paths `all` must skip: Orca's shared symlinks, already verified as symlinks. */
  excludedUntrackedPaths?: readonly string[]
}

function nulSeparatedPaths(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean)
}

export async function stageGitWorktreeScope(
  scope: GitStageWorktreeScope,
  runGit: GitStageRunner,
  options: StageGitWorktreeScopeOptions = {}
): Promise<GitStageWorktreeScopeReceipt> {
  const excluded = scope === 'all' ? (options.excludedUntrackedPaths ?? []) : []
  // Why: --relative keeps a folder workspace inside a larger repo from staging outside its folder.
  const unresolved = nulSeparatedPaths(
    (await runGit(['diff', '--name-only', '--relative', '-z', '--diff-filter=U'])).stdout
  )
  if (unresolved.length === 0) {
    if (excluded.length === 0) {
      await runGit(['add', scope === 'all' ? '--all' : '--update', '--', '.'])
      return { stagedScope: scope }
    }
    // Why: the exclude must only hide the untracked link; tracked changes at that path still stage.
    await runGit(['add', '--update', '--', '.'])
    await runGit([
      'add',
      '--all',
      '--',
      '.',
      ...excluded.map((path) => `:(exclude,literal)${path}`)
    ])
    return { stagedScope: scope }
  }
  // Why: `git add` resolves an unmerged path even under an exclude pathspec, so name the rest instead.
  const unresolvedSet = new Set(unresolved)
  const excludedSet = new Set(excluded)
  const tracked = nulSeparatedPaths(
    (await runGit(['diff', '--name-only', '--relative', '-z'])).stdout
  ).filter((path) => !unresolvedSet.has(path))
  const untracked =
    scope === 'all'
      ? nulSeparatedPaths(
          (await runGit(['ls-files', '-z', '--others', '--exclude-standard'])).stdout
        ).filter((path) => !excludedSet.has(path))
      : []
  const paths = [...new Set([...tracked, ...untracked])]
  if (paths.length > 0) {
    await runGit(
      ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
      encodeGitPathspecs(paths.map((path) => `:(literal)${path}`))
    )
  }
  return { stagedScope: scope }
}
