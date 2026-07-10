import { isNoUpstreamError } from './git-remote-error'
import type { GitUpstreamStatus } from './types'
import {
  getConfiguredBranchRemoteUpstream,
  hasConfiguredBranchPushTarget
} from './git-configured-branch-target'
import { splitRemoteBranchName } from './git-remote-branch-name'
import { parseGitRevListAheadBehindCounts } from './git-rev-list-output'
import { iterateProcessOutputLines } from './process-output-field-scanner'

export { gitRefTargetsBranchName, splitRemoteBranchName } from './git-remote-branch-name'

export type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

export type EffectiveGitUpstream =
  | {
      upstreamName: string
      remoteName: string | null
      branchName: string
      isConfiguredUpstream: true
    }
  | {
      upstreamName: string
      remoteName: string
      branchName: string
      isConfiguredUpstream: false
    }

function hasMultipleSlashSegments(refName: string): boolean {
  return refName.includes('/') && refName.indexOf('/') !== refName.lastIndexOf('/')
}

async function splitRemoteBranchNameByKnownRemote(
  runGit: GitCommandRunner,
  refName: string
): Promise<{ remoteName: string; branchName: string } | null> {
  try {
    const { stdout } = await runGit(['remote'])
    let bestRemoteName: string | null = null
    for (const rawLine of iterateProcessOutputLines(stdout)) {
      const remoteName = rawLine.trim()
      // Why: preserve longest-remote matching for remote names that contain slashes.
      if (
        !remoteName ||
        refName === remoteName ||
        !refName.startsWith(`${remoteName}/`) ||
        (bestRemoteName && bestRemoteName.length >= remoteName.length)
      ) {
        continue
      }
      bestRemoteName = remoteName
    }
    if (!bestRemoteName) {
      return null
    }
    const branchName = refName.slice(bestRemoteName.length + 1)
    return branchName ? { remoteName: bestRemoteName, branchName } : null
  } catch {
    return null
  }
}

async function getCurrentBranchName(runGit: GitCommandRunner): Promise<string | null> {
  try {
    const { stdout } = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const branchName = stdout.trim()
    return branchName || null
  } catch {
    return null
  }
}

async function getConfiguredUpstream(
  runGit: GitCommandRunner
): Promise<EffectiveGitUpstream | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD@{u}'])
    const upstreamName = stdout.trim()
    if (!upstreamName) {
      return null
    }
    const parsed = splitRemoteBranchName(upstreamName)
    if (!parsed) {
      return {
        upstreamName,
        remoteName: null,
        branchName: upstreamName,
        isConfiguredUpstream: true
      }
    }
    return {
      upstreamName,
      remoteName: parsed.remoteName,
      branchName: parsed.branchName,
      isConfiguredUpstream: true
    }
  } catch (error) {
    if (isNoUpstreamError(error)) {
      return null
    }
    throw error
  }
}

async function remoteTrackingRefExists(
  runGit: GitCommandRunner,
  remoteName: string,
  branchName: string
): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteName}/${branchName}`])
    return true
  } catch {
    return false
  }
}

async function resolveEffectiveGitUpstreamForBranch(
  runGit: GitCommandRunner,
  currentBranchName: string | null
): Promise<EffectiveGitUpstream | null> {
  let configured = await getConfiguredUpstream(runGit)

  if (configured) {
    if (
      currentBranchName &&
      configured.remoteName === 'origin' &&
      configured.branchName !== currentBranchName &&
      hasMultipleSlashSegments(configured.upstreamName)
    ) {
      const parsed = await splitRemoteBranchNameByKnownRemote(runGit, configured.upstreamName)
      if (parsed) {
        configured = { ...configured, ...parsed }
      }
    }

    if (!currentBranchName || configured.branchName === currentBranchName) {
      return configured
    }

    // Why: older Orca worktrees inherited origin/main as their upstream even
    // though pushes target origin/<current-branch>. If that same-name remote
    // exists, source-control pull/sync must follow the publish branch rather
    // than the base branch.
    if (
      configured.remoteName === 'origin' &&
      (await remoteTrackingRefExists(runGit, configured.remoteName, currentBranchName))
    ) {
      return {
        upstreamName: `${configured.remoteName}/${currentBranchName}`,
        remoteName: configured.remoteName,
        branchName: currentBranchName,
        isConfiguredUpstream: false
      }
    }

    return configured
  }

  if (currentBranchName) {
    const branchRemoteUpstream = await getConfiguredBranchRemoteUpstream(
      runGit,
      currentBranchName,
      (remoteName, branchName) => remoteTrackingRefExists(runGit, remoteName, branchName)
    )
    if (branchRemoteUpstream) {
      // Why: Git cannot resolve HEAD@{u} when branch.<name>.remote is a URL,
      // but older fork-review worktrees still carry the usable merge target.
      return branchRemoteUpstream
    }
  }

  if (currentBranchName && (await remoteTrackingRefExists(runGit, 'origin', currentBranchName))) {
    return {
      upstreamName: `origin/${currentBranchName}`,
      remoteName: 'origin',
      branchName: currentBranchName,
      isConfiguredUpstream: false
    }
  }

  return null
}

export async function resolveEffectiveGitUpstream(
  runGit: GitCommandRunner
): Promise<EffectiveGitUpstream | null> {
  return resolveEffectiveGitUpstreamForBranch(runGit, await getCurrentBranchName(runGit))
}

export async function getEffectiveGitUpstreamStatus(
  runGit: GitCommandRunner,
  getBehindCommitsArePatchEquivalent?: (upstreamName: string) => Promise<boolean>
): Promise<GitUpstreamStatus> {
  const currentBranchName = await getCurrentBranchName(runGit)
  const upstream = await resolveEffectiveGitUpstreamForBranch(runGit, currentBranchName)
  if (!upstream) {
    const hasConfiguredPushTarget = currentBranchName
      ? await hasConfiguredBranchPushTarget(runGit, currentBranchName)
      : false
    return {
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      ...(hasConfiguredPushTarget ? { hasConfiguredPushTarget: true } : {})
    }
  }

  return getGitUpstreamStatusForUpstreamName(
    runGit,
    upstream.upstreamName,
    getBehindCommitsArePatchEquivalent
  )
}

/**
 * Ahead/behind status for an already-resolved upstream name. Split out so
 * callers that cached the resolution (a pure function of branch/config state)
 * can refresh the counts with a single rev-list spawn instead of re-running
 * the whole resolution chain.
 */
export async function getGitUpstreamStatusForUpstreamName(
  runGit: GitCommandRunner,
  upstreamName: string,
  getBehindCommitsArePatchEquivalent?: (upstreamName: string) => Promise<boolean>
): Promise<GitUpstreamStatus> {
  const { stdout } = await runGit(['rev-list', '--left-right', '--count', `HEAD...${upstreamName}`])
  const counts = parseGitRevListAheadBehindCounts(stdout)
  if (counts.status === 'unexpected-field-count') {
    throw new Error(`Unexpected git rev-list output: ${JSON.stringify(stdout)}`)
  }
  if (counts.status === 'unparseable-counts') {
    throw new Error(`Unparseable git rev-list counts: ${JSON.stringify(stdout)}`)
  }

  const behindCommitsArePatchEquivalent =
    counts.ahead > 0 && counts.behind > 0 && getBehindCommitsArePatchEquivalent
      ? await getBehindCommitsArePatchEquivalent(upstreamName)
      : undefined

  return {
    hasUpstream: true,
    upstreamName,
    ahead: counts.ahead,
    behind: counts.behind,
    ...(behindCommitsArePatchEquivalent !== undefined ? { behindCommitsArePatchEquivalent } : {})
  }
}
