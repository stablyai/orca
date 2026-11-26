import { windowsLongPathGitArgs } from '../../git/compatibility/windows-long-path-git-args'
import { retryOnGitLockContention } from '../../git/commands/git-lock-contention'
import { parseGitRevListAheadBehindCounts } from '../../git/refs/git-rev-list-output'
import { isShowRefNoMatchError } from '../../git/refs/git-show-ref-no-match'
import type { LocalBaseRefRefreshResult } from './base-ref-drift-types'

type BranchUse = { reserved: boolean; ownerPath?: string; sharedCheckout?: true }

/** Share one policy across local/WSL main and SSH relay. exec rejects nonzero exits with Git output attached. */
export type LocalBaseBranchGit = {
  exec: (args: string[], cwd: string) => Promise<{ stdout: string }>
  /** Whether a rebase or bisect reserves the branch (its worktree shows a detached HEAD), else the path of the worktree that has it checked out, as this host reports it; `sharedCheckout` when no one checkout of the branch itself can be fast-forwarded (several share it, or one has the branch it aliases). `occupancyOnly` callers only need to know it is checked out. */
  readBranchUse: (repo: string, ref: string, occupancyOnly?: boolean) => Promise<BranchUse>
  /** Runs `update-ref args` unless the branch is in use, rechecked once admitted, just before Git starts; false when skipped. */
  updateRefUnlessInUse: (repoPath: string, fullRef: string, args: string[]) => Promise<boolean>
}

export type LocalBaseBranchRefs = {
  repoPath: string
  /** `refs/heads/<branch>` */
  fullRef: string
  /** `refs/remotes/<remote>/<branch>` */
  remoteTrackingRef: string
}

type LocalBaseRefRefreshStatus = LocalBaseRefRefreshResult['status']

export type LocalBaseBranchInspection =
  /** Nothing Orca may move: local matches, does not exist yet (#15331), or its checkout or a rebase/bisect owns it. */
  | { status: 'nothing_to_do' }
  | {
      status: 'behind'
      behind: number
      localOid: string
      remoteOid: string
      /** Set when a worktree has the branch checked out; only that checkout may move it. */
      ownerWorktreePath?: string
    }
  | {
      status: Exclude<LocalBaseRefRefreshStatus, 'updated'>
      shallowHistory?: true
    }

export type LocalBaseBranchFastForwardOutcome =
  | { status: 'nothing_to_do' }
  | { status: LocalBaseRefRefreshStatus; ownerWorktreePath?: string; shallowHistory?: true }

// Force a plain fast-forward without hooks, auto-GC, autostash, branch mergeOptions, signature refusal or ignored-file overwrite. Flags override config; older Git ignores unknown keys.
// /dev/null/<hook> never exists. Git 2.25 has neither ort nor --no-autostash.
function ownerFastForwardArgs(branch: string, targetOid: string): string[] {
  return [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
    '-c',
    'merge.autoStash=false',
    '-c',
    `branch.${branch}.mergeOptions=`,
    'merge',
    '--ff-only',
    '-s',
    'recursive',
    '--no-verify-signatures',
    '--no-overwrite-ignore',
    '--no-stat',
    '-q',
    targetOid
  ]
}

type InspectOptions = { skipCheckedOut?: boolean; skipShared?: boolean; occupancyOnly?: boolean }

/** Read-only inspection of local drift. A checked-out branch is reported only when strictly behind, so its checkout stays silent otherwise; `skipCheckedOut` (or `skipShared`, for a branch several checkouts share) stops before walking its history; `occupancyOnly` skips locating the owner. */
export async function inspectLocalBaseBranch(
  git: LocalBaseBranchGit,
  refs: LocalBaseBranchRefs,
  { skipCheckedOut = false, skipShared = false, occupancyOnly = false }: InspectOptions = {}
): Promise<LocalBaseBranchInspection> {
  const { repoPath, fullRef, remoteTrackingRef } = refs
  let localOid: string
  let remoteOid: string
  try {
    localOid = await revParseCommit(git, repoPath, fullRef)
    remoteOid = await revParseCommit(git, repoPath, remoteTrackingRef)
    if (localOid === remoteOid) {
      return { status: 'nothing_to_do' }
    }
  } catch {
    // Only proven branch absence suppresses the warning; repo/transport failure cannot (#15331).
    return (await isRefProvenAbsent(git, repoPath, fullRef))
      ? { status: 'nothing_to_do' }
      : { status: 'skipped_not_fast_forward' }
  }

  let use: BranchUse
  try {
    // Git's in-use rule also counts a branch a rebase or bisect has reserved.
    use = await git.readBranchUse(repoPath, fullRef, skipCheckedOut || occupancyOnly)
  } catch {
    return { status: 'skipped_error' }
  }
  const owner = use.ownerPath
  if (use.reserved || (owner && (skipCheckedOut || (skipShared && use.sharedCheckout)))) {
    return { status: 'nothing_to_do' }
  }
  const ownerPath = owner ? { ownerWorktreePath: owner } : {}

  let counts: ReturnType<typeof parseGitRevListAheadBehindCounts>
  try {
    const { stdout } = await git.exec(
      ['rev-list', '--left-right', '--count', `${localOid}...${remoteOid}`],
      repoPath
    )
    counts = parseGitRevListAheadBehindCounts(stdout)
  } catch {
    return owner ? { status: 'nothing_to_do' } : { status: 'skipped_not_fast_forward' }
  }
  if (counts.status === 'ok' && counts.ahead === 0 && counts.behind > 0) {
    return { status: 'behind', behind: counts.behind, localOid, remoteOid, ...ownerPath }
  }
  if (owner) {
    return { status: 'nothing_to_do' }
  }
  return (await isHistoryCutByShallowClone(git, repoPath, localOid, remoteOid))
    ? { status: 'skipped_not_fast_forward', shallowHistory: true }
    : { status: 'skipped_not_fast_forward' }
}

/** Fast-forward a branch no worktree has checked out with a compare-and-swap update-ref, never touching a working tree or index. Never rejects. */
export async function fastForwardLocalBaseBranch(
  git: LocalBaseBranchGit,
  refs: LocalBaseBranchRefs
): Promise<LocalBaseBranchFastForwardOutcome> {
  // A checked-out branch is left to fastForwardCheckedOutLocalBaseBranch, after the create.
  const inspection = await inspectLocalBaseBranch(git, refs, { skipCheckedOut: true })
  if (inspection.status !== 'behind') {
    return inspection
  }
  const { repoPath, fullRef, remoteTrackingRef } = refs
  const { localOid, remoteOid } = inspection
  try {
    // A checkout made after the last check would be stranded, so the check runs right before the write.
    const moved = await retryOnGitLockContention(() =>
      git.updateRefUnlessInUse(repoPath, fullRef, [
        'update-ref',
        '-m',
        `orca: fast-forward to ${remoteTrackingRef}`,
        fullRef,
        remoteOid,
        localOid
      ])
    )
    return moved ? { status: 'updated' } : { status: 'nothing_to_do' }
  } catch {
    // A concurrent pull/Orca update may already have moved local; a user commit leaves it diverged.
    try {
      if (await isAncestor(git, repoPath, remoteOid, fullRef)) {
        return { status: 'updated' }
      }
      if (!(await isAncestor(git, repoPath, fullRef, remoteOid))) {
        return { status: 'skipped_not_fast_forward' }
      }
    } catch {
      // Git could not answer; report the failure itself.
    }
    return { status: 'skipped_error' }
  }
}

/** Fast-forward a checked-out branch in its own checkout when it has no tracked changes; Git refuses a held index.lock, overwritten untracked files and dropped commits. Silent; never rejects. */
export async function fastForwardCheckedOutLocalBaseBranch(
  git: LocalBaseBranchGit,
  refs: LocalBaseBranchRefs
): Promise<void> {
  const inspection = await inspectLocalBaseBranch(git, refs, { skipShared: true })
  if (inspection.status !== 'behind' || !inspection.ownerWorktreePath) {
    return
  }
  const { ownerWorktreePath, remoteOid } = inspection
  const branch = refs.fullRef.slice('refs/heads/'.length)
  // Why: `-c branch.<name>.mergeOptions=` splits at the first `=`, so such a name cannot be pinned.
  if (branch.includes('=')) {
    return
  }
  try {
    if (await hasTrackedChanges(git, ownerWorktreePath)) {
      return
    }
    // Recheck right before merging HEAD: the checkout may have switched branches since the listing.
    const { stdout: head } = await git.exec(['symbolic-ref', '-q', 'HEAD'], ownerWorktreePath)
    if (head.trim() !== refs.fullRef) {
      return
    }
    await git.exec(
      [...windowsLongPathGitArgs(ownerWorktreePath), ...ownerFastForwardArgs(branch, remoteOid)],
      ownerWorktreePath
    )
  } catch {
    // A skipped update stays silent; the next create tries again.
  }
}

export function toLocalBaseRefRefreshResult(
  names: { baseRef: string; localBranch: string },
  outcome: LocalBaseBranchFastForwardOutcome | undefined
): LocalBaseRefRefreshResult | undefined {
  if (!outcome || outcome.status === 'nothing_to_do') {
    return undefined
  }
  return {
    baseRef: names.baseRef,
    localBranch: names.localBranch,
    status: outcome.status,
    ...(outcome.ownerWorktreePath ? { ownerWorktreePath: outcome.ownerWorktreePath } : {}),
    ...('shallowHistory' in outcome && outcome.shallowHistory ? { shallowHistory: true } : {})
  }
}

async function hasTrackedChanges(git: LocalBaseBranchGit, worktreePath: string): Promise<boolean> {
  // Read without index.lock so inspection cannot fail the user's concurrent Git command.
  const { stdout } = await git.exec(
    ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'],
    worktreePath
  )
  return stdout.trim().length > 0
}

async function revParseCommit(
  git: LocalBaseBranchGit,
  repoPath: string,
  ref: string
): Promise<string> {
  const { stdout } = await git.exec(['rev-parse', '--verify', `${ref}^{commit}`], repoPath)
  const oid = stdout.trim()
  if (!oid) {
    throw new Error(`${ref} did not resolve to a commit`)
  }
  return oid
}

// Shallow boundaries make older commits look ahead; require a missing merge base to distinguish that from divergence.
async function isHistoryCutByShallowClone(
  git: LocalBaseBranchGit,
  repoPath: string,
  localOid: string,
  remoteOid: string
): Promise<boolean> {
  try {
    const { stdout } = await git.exec(['rev-parse', '--is-shallow-repository'], repoPath)
    if (stdout.trim() !== 'true') {
      return false
    }
  } catch {
    return false
  }
  try {
    await git.exec(['merge-base', localOid, remoteOid], repoPath)
    return false
  } catch (error) {
    // merge-base reports no common ancestor like show-ref reports no ref: exit 1, silent stderr.
    return isShowRefNoMatchError(error)
  }
}

async function isRefProvenAbsent(
  git: LocalBaseBranchGit,
  repoPath: string,
  fullRef: string
): Promise<boolean> {
  try {
    await git.exec(['show-ref', '--verify', '--quiet', '--', fullRef], repoPath)
    return false
  } catch (error) {
    return isShowRefNoMatchError(error)
  }
}

async function isAncestor(
  git: LocalBaseBranchGit,
  repoPath: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  try {
    await git.exec(['merge-base', '--is-ancestor', ancestor, descendant], repoPath)
    return true
  } catch (error) {
    // Only Git's silent exit 1 means "not an ancestor"; anything else is a failure to answer.
    if (isShowRefNoMatchError(error)) {
      return false
    }
    throw error
  }
}
