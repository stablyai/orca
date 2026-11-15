import { retryOnGitLockContention } from '../../git/commands/git-lock-contention'
import { parseGitRevListAheadBehindCounts } from '../../git/refs/git-rev-list-output'
import { isShowRefNoMatchError } from '../../git/refs/git-show-ref-no-match'
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
  /** Nothing Orca may move: local matches, does not exist yet (#15331), or a worktree has it checked out. */
  | { status: 'nothing_to_do' }
  | { status: 'behind'; behind: number; localOid: string; remoteOid: string }
  | {
      status: Exclude<LocalBaseRefRefreshStatus, 'updated'>
      shallowHistory?: true
    }

export type LocalBaseBranchFastForwardOutcome =
  | { status: 'nothing_to_do' }
  | { status: LocalBaseRefRefreshStatus; ownerWorktreePath?: string; shallowHistory?: true }

/** Read-only inspection of local drift. A checked-out branch belongs to its checkout, so it is never offered for update. */
export async function inspectLocalBaseBranch(
  git: LocalBaseBranchGit,
  refs: LocalBaseBranchRefs
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

  try {
    if ((await git.listWorktrees(repoPath)).some((wt) => wt.branch === fullRef)) {
      return { status: 'nothing_to_do' }
    }
  } catch {
    return { status: 'skipped_error' }
  }

  let counts: ReturnType<typeof parseGitRevListAheadBehindCounts>
  try {
    const { stdout } = await git.exec(
      ['rev-list', '--left-right', '--count', `${localOid}...${remoteOid}`],
      repoPath
    )
    counts = parseGitRevListAheadBehindCounts(stdout)
  } catch {
    return { status: 'skipped_not_fast_forward' }
  }
  if (counts.status === 'ok' && counts.ahead === 0 && counts.behind > 0) {
    return { status: 'behind', behind: counts.behind, localOid, remoteOid }
  }
  return (await isHistoryCutByShallowClone(git, repoPath, localOid, remoteOid))
    ? { status: 'skipped_not_fast_forward', shallowHistory: true }
    : { status: 'skipped_not_fast_forward' }
}

/** Fast-forward a branch no worktree has checked out with a compare-and-swap update-ref: no working tree, index or hooks. Never rejects. */
export async function fastForwardLocalBaseBranch(
  git: LocalBaseBranchGit,
  refs: LocalBaseBranchRefs
): Promise<LocalBaseBranchFastForwardOutcome> {
  const inspection = await inspectLocalBaseBranch(git, refs)
  if (inspection.status !== 'behind') {
    return inspection
  }
  const { repoPath, fullRef, remoteTrackingRef } = refs
  const { localOid, remoteOid } = inspection
  try {
    await retryOnGitLockContention(() =>
      git.exec(
        ['update-ref', '-m', `orca: fast-forward to ${remoteTrackingRef}`, fullRef, remoteOid, localOid],
        repoPath
      )
    )
    return { status: 'updated' }
  } catch {
    // A concurrent pull/Orca update may already have moved local.
    return (await localContains(git, repoPath, fullRef, remoteOid))
      ? { status: 'updated' }
      : { status: 'skipped_error' }
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
