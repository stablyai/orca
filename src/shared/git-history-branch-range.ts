import {
  resolveEffectiveGitUpstream,
  splitRemoteBranchNameByKnownRemote
} from './git-effective-upstream'
import type {
  GitHistoryBranchRange,
  GitHistoryExecutor,
  GitHistoryItemRef
} from './git-history-types'

// On main with base origin/main there is no branch to cut out, so the page keeps HEAD's whole history.
export async function isBaseOfItself(
  git: GitHistoryExecutor,
  cwd: string,
  baseRef: GitHistoryItemRef,
  currentRef: GitHistoryItemRef
): Promise<boolean> {
  if (baseRef.id === currentRef.id) {
    return true
  }
  if (
    baseRef.category !== 'remote branches' ||
    currentRef.category !== 'branches' ||
    !baseRef.name.endsWith(`/${currentRef.name}`)
  ) {
    return false
  }
  // Remote names may contain slashes, so split at a configured remote rather than the first slash.
  const split = await splitRemoteBranchNameByKnownRemote((args) => git(args, cwd), baseRef.name)
  return split?.branchName === currentRef.name
}

export async function resolveBranchRange(
  git: GitHistoryExecutor,
  cwd: string,
  headOid: string,
  baseRef: GitHistoryItemRef
): Promise<{ range: GitHistoryBranchRange; unpushedIds: ReadonlySet<string> | null } | undefined> {
  const baseOid = baseRef.revision
  if (!baseOid) {
    return undefined
  }
  try {
    const { stdout } = await git(
      ['rev-list', '--left-right', '--count', `${baseOid}...${headOid}`],
      cwd
    )
    const [behind, ahead] = stdout.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(behind) || !Number.isInteger(ahead)) {
      return undefined
    }
    const upstreamOid = await resolveEffectiveUpstreamOid(git, cwd)
    // No upstream means nothing on this branch has been pushed yet.
    if (!upstreamOid) {
      return {
        range: { baseRef, ahead, behind, unpushed: ahead },
        unpushedIds: null
      }
    }
    // Bounded by the branch's own commits, since the base is excluded too.
    const unpushedOut = await git(['rev-list', headOid, `^${upstreamOid}`, `^${baseOid}`], cwd)
    const unpushedIds = new Set(unpushedOut.stdout.split(/\s+/).filter(Boolean))
    return {
      range: { baseRef, ahead, behind, unpushed: unpushedIds.size },
      unpushedIds
    }
  } catch {
    // A failed count falls back to full history, like a host without branchOnly.
    return undefined
  }
}

// The upstream Push and Sync use, so a pushed commit here agrees with git.upstreamStatus.
async function resolveEffectiveUpstreamOid(
  git: GitHistoryExecutor,
  cwd: string
): Promise<string | null> {
  const upstream = await resolveEffectiveGitUpstream((args) => git(args, cwd)).catch(() => null)
  if (!upstream) {
    return null
  }
  // Resolve the name as git.upstreamStatus does: a local upstream like team/base has no refs/remotes entry.
  try {
    const { stdout } = await git(
      ['rev-parse', '--verify', '--end-of-options', `${upstream.upstreamName}^{commit}`],
      cwd
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}
