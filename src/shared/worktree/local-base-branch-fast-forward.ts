import { readGitCommandFailureText } from '../git-command-failure-text'
import { retryOnGitLockContention } from '../git-lock-contention'
import { parseGitRevListAheadBehindCounts } from '../git-rev-list-output'
import { isShowRefNoMatchError } from '../git-show-ref-no-match'
import type { LocalBaseRefRefreshResult } from './base-ref-drift-types'

/** Share one policy across local/WSL main and SSH relay. exec rejects nonzero exits with Git output attached. */
export type LocalBaseBranchGit = {
  exec: (args: string[], cwd: string) => Promise<{ stdout: string }>
  /** Each worktree's path and checked-out branch as a full ref, as this host reports them. */
  listWorktrees: (repoPath: string) => Promise<readonly { path: string; branch?: string | null }[]>
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
  /** Nothing stale: local already matches, or does not exist yet (#15331). */
  | { status: 'nothing_to_do' }
  | {
      status: 'behind'
      behind: number
      localOid: string
      remoteOid: string
      ownerWorktreePath?: string
    }
  | {
      status: Exclude<LocalBaseRefRefreshStatus, 'updated'>
      ownerWorktreePath?: string
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

/** Read-only inspection of local drift and checkout readiness. */
export async function inspectLocalBaseBranch(
  git: LocalBaseBranchGit,
  refs: LocalBaseBranchRefs
): Promise<LocalBaseBranchInspection> {
  const { repoPath, fullRef, remoteTrackingRef } = refs
  let localOid: string
  let remoteOid: string
  let behind: number
  try {
    localOid = await revParseCommit(git, repoPath, fullRef)
    remoteOid = await revParseCommit(git, repoPath, remoteTrackingRef)
    if (localOid === remoteOid) {
      return { status: 'nothing_to_do' }
    }
    const { stdout } = await git.exec(
      ['rev-list', '--left-right', '--count', `${localOid}...${remoteOid}`],
      repoPath
    )
    const counts = parseGitRevListAheadBehindCounts(stdout)
    if (counts.status !== 'ok' || counts.ahead !== 0 || counts.behind === 0) {
      return (await isHistoryCutByShallowClone(git, repoPath, localOid, remoteOid))
        ? { status: 'skipped_not_fast_forward', shallowHistory: true }
        : { status: 'skipped_not_fast_forward' }
    }
    behind = counts.behind
  } catch {
    // Only proven branch absence suppresses the warning; repo/transport failure cannot (#15331).
    return (await isRefProvenAbsent(git, repoPath, fullRef))
      ? { status: 'nothing_to_do' }
      : { status: 'skipped_not_fast_forward' }
  }

  try {
    const owner = (await git.listWorktrees(repoPath)).find((wt) => wt.branch === fullRef)
    if (!owner) {
      return { status: 'behind', behind, localOid, remoteOid }
    }
    if (await hasTrackedChanges(git, owner.path)) {
      return { status: 'skipped_dirty_worktree', ownerWorktreePath: owner.path }
    }
    return { status: 'behind', behind, localOid, remoteOid, ownerWorktreePath: owner.path }
  } catch {
    return { status: 'skipped_error' }
  }
}

/** Fast-forward with Git’s index-lock protections in an owner checkout, or compare-and-swap update-ref for a free branch. Refuse overwritten edits/untracked files or dropped commits; never reject. */
export async function fastForwardLocalBaseBranch(
  git: LocalBaseBranchGit,
  refs: LocalBaseBranchRefs
): Promise<LocalBaseBranchFastForwardOutcome> {
  const inspection = await inspectLocalBaseBranch(git, refs)
  if (inspection.status !== 'behind') {
    return inspection
  }
  const { repoPath, fullRef, remoteTrackingRef } = refs
  const { localOid, remoteOid, ownerWorktreePath } = inspection
  const owner = ownerWorktreePath ? { ownerWorktreePath } : {}
  const branch = fullRef.slice('refs/heads/'.length)
  if (ownerWorktreePath && branch.includes('=')) {
    // Why: `-c branch.<name>.mergeOptions=` splits at the first `=`, so such a name cannot be pinned.
    return { status: 'skipped_error', ...owner }
  }
  try {
    await retryOnGitLockContention(async () => {
      if (!ownerWorktreePath) {
        await git.exec(
          [
            'update-ref',
            '-m',
            `orca: fast-forward to ${remoteTrackingRef}`,
            fullRef,
            remoteOid,
            localOid
          ],
          repoPath
        )
        return
      }
      // Recheck the owner’s branch before merging HEAD; this narrows the switch race, and post-move verification warns if it occurred.
      const { stdout: head } = await git.exec(['symbolic-ref', '-q', 'HEAD'], ownerWorktreePath)
      if (head.trim() !== fullRef) {
        throw new Error(`${fullRef} is no longer checked out at ${ownerWorktreePath}`)
      }
      await git.exec(ownerFastForwardArgs(branch, remoteOid), ownerWorktreePath)
    })
    // Report updated only if local equals the target, regardless of merge settings.
    if (ownerWorktreePath && (await revParseCommit(git, repoPath, fullRef)) !== remoteOid) {
      return { status: 'skipped_error', ...owner }
    }
    return { status: 'updated', ...owner }
  } catch (error) {
    // A concurrent pull/Orca update may already have moved local.
    if (await localContains(git, repoPath, fullRef, remoteOid)) {
      return { status: 'updated', ...owner }
    }
    return { status: classifyFastForwardFailure(error), ...owner }
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

function classifyFastForwardFailure(error: unknown): Exclude<LocalBaseRefRefreshStatus, 'updated'> {
  const text = readGitCommandFailureText(error)
  if (/would be overwritten by merge|would lose untracked files/i.test(text)) {
    return 'skipped_dirty_worktree'
  }
  if (/Not possible to fast-forward/i.test(text)) {
    return 'skipped_not_fast_forward'
  }
  return 'skipped_error'
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

async function hasTrackedChanges(git: LocalBaseBranchGit, worktreePath: string): Promise<boolean> {
  // Read without index.lock so inspection cannot fail the user’s concurrent Git command.
  const { stdout } = await git.exec(
    ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'],
    worktreePath
  )
  return stdout.trim().length > 0
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

async function localContains(
  git: LocalBaseBranchGit,
  repoPath: string,
  fullRef: string,
  oid: string
): Promise<boolean> {
  try {
    await git.exec(['merge-base', '--is-ancestor', oid, fullRef], repoPath)
    return true
  } catch {
    return false
  }
}

const REFRESH_STATUSES: readonly LocalBaseRefRefreshStatus[] = [
  'updated',
  'skipped_dirty_worktree',
  'skipped_not_fast_forward',
  'skipped_error'
]

/** Reject unrecognized relay replies as errors rather than implying success. */
export function parseLocalBaseBranchFastForwardOutcome(
  value: unknown
): LocalBaseBranchFastForwardOutcome {
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    return { status: 'skipped_error' }
  }
  if (value.status === 'nothing_to_do') {
    return { status: 'nothing_to_do' }
  }
  const status = REFRESH_STATUSES.find((candidate) => candidate === value.status)
  if (!status) {
    return { status: 'skipped_error' }
  }
  const ownerWorktreePath = 'ownerWorktreePath' in value ? value.ownerWorktreePath : undefined
  const shallowHistory = 'shallowHistory' in value && value.shallowHistory === true
  return {
    status,
    ...(typeof ownerWorktreePath === 'string' && ownerWorktreePath ? { ownerWorktreePath } : {}),
    ...(shallowHistory ? { shallowHistory: true } : {})
  }
}

/** How many commits a relay's inspection says local is behind, when it may be fast-forwarded. */
export function readFastForwardableBehindCount(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || !('status' in value) || !('behind' in value)) {
    return undefined
  }
  const { behind } = value
  return value.status === 'behind' && typeof behind === 'number' && behind > 0 ? behind : undefined
}
