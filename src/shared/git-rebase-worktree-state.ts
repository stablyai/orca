import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRebaseHeadName } from './git-rebase-head-name'
import { resolveWorktreeGitDir } from './git-worktree-dir'

export type WorktreeRebaseState = { rebasing: boolean; rebaseBranch: string | null }

/**
 * Recover the branch a worktree is rebasing from git's on-disk rebase state files.
 * Version-agnostic (reads plain state files, no git subcommand). Why: the single rebase
 * detector for every producer — relay/main worktree lists, main/relay status ops, and the
 * head-identity watcher — so their rebase detection can't silently drift.
 */
export async function readWorktreeRebaseState(worktreePath: string): Promise<WorktreeRebaseState> {
  return readRebaseStateFromGitDir(await resolveWorktreeGitDir(worktreePath))
}

/**
 * Second-chance probe for a status/identity read that observed a detached HEAD after an
 * early probe saw no rebase. Why: probing before the HEAD read protects `rebase --abort`
 * torn reads, but leaves the mirror-image window at rebase *start* (probe → git writes
 * state and detaches → HEAD read), where the detach would misread as a plain branch
 * switch — which consumers punish by clearing the branch-scoped review link. Re-probing
 * on the {detached, not rebasing} combination errs toward "rebasing" on both edges.
 * Callers gate on "HEAD was detached" so attached-HEAD reads stay single-probe.
 */
export async function reprobeDetachedHeadRebaseState(
  earlyState: WorktreeRebaseState,
  reprobe: () => Promise<WorktreeRebaseState>
): Promise<WorktreeRebaseState> {
  if (earlyState.rebasing) {
    return earlyState
  }
  try {
    return await reprobe()
  } catch {
    return earlyState
  }
}

/** Same probe for callers that already resolved the worktree's git dir. */
export async function readRebaseStateFromGitDir(gitDir: string): Promise<WorktreeRebaseState> {
  let rebaseDir: string | null = null
  if (existsSync(join(gitDir, 'rebase-merge'))) {
    // rebase-merge is written only by rebase (interactive/merge backend).
    rebaseDir = join(gitDir, 'rebase-merge')
  } else if (
    existsSync(join(gitDir, 'rebase-apply')) &&
    existsSync(join(gitDir, 'rebase-apply', 'rebasing'))
  ) {
    // rebase-apply is shared with `git am`; gate on the `rebasing` sentinel (git writes
    // `applying` for `git am`) to avoid a false badge.
    rebaseDir = join(gitDir, 'rebase-apply')
  }

  if (!rebaseDir) {
    return { rebasing: false, rebaseBranch: null }
  }

  try {
    const headName = await readFile(join(rebaseDir, 'head-name'), 'utf-8')
    return { rebasing: true, rebaseBranch: parseRebaseHeadName(headName) }
  } catch {
    // Why: `git rebase --continue/--abort` can prune the state dir between the probe above and
    // this read; if it's gone the rebase actually ended — don't report a stale "rebasing".
    if (!existsSync(rebaseDir)) {
      return { rebasing: false, rebaseBranch: null }
    }
    // Rebase in progress but head-name is unreadable/absent — known rebasing, no branch.
    return { rebasing: true, rebaseBranch: null }
  }
}
