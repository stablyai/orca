import { getGitCurrentBranchName } from './git-current-branch'
import { isNoUpstreamError } from './git-remote-error'
import type { GitUpstreamStatus } from './git-status-types'
import {
  getConfiguredBranchRemoteUpstream,
  hasConfiguredBranchPushTarget
} from './git-configured-branch-target'
import { parseGitRevListAheadBehindCounts } from './git-rev-list-output'
import { createGitConfigSnapshotRunner } from './git-config-snapshot-runner'

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

async function getConfiguredUpstream(
  runGit: GitCommandRunner,
  branch: string | null
): Promise<EffectiveGitUpstream | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD@{u}'])
    const upstreamName = stdout.trim()
    if (!upstreamName) {
      return null
    }
    const atoms = branch
      ? (
          await runGit([
            'for-each-ref',
            '--format=%(upstream:remotename)%00%(upstream:remoteref)',
            `refs/heads/${branch}`
          ])
        ).stdout
          .trim()
          .split('\0')
      : []
    return {
      upstreamName,
      remoteName: atoms[0] || null,
      branchName: atoms[1]?.replace(/^refs\/heads\//, '') || upstreamName,
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
  let configured = await getConfiguredUpstream(runGit, currentBranchName)

  if (configured) {
    if (!currentBranchName || configured.branchName === currentBranchName) {
      return configured
    }

    // Legacy worktrees tracked origin/main while publishing same-name branches; pull/sync must follow the existing publish branch.
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
      // URL-valued branch.remote breaks HEAD@{u}; legacy fork-review worktrees can still supply a usable merge target.
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
  execGit: GitCommandRunner
): Promise<EffectiveGitUpstream | null> {
  const runGit = createGitConfigSnapshotRunner(execGit)
  return resolveEffectiveGitUpstreamForBranch(runGit, await getGitCurrentBranchName(runGit))
}

export async function getEffectiveGitUpstreamStatus(
  execGit: GitCommandRunner,
  getBehindCommitsArePatchEquivalent?: (upstreamName: string) => Promise<boolean>
): Promise<GitUpstreamStatus> {
  const runGit = createGitConfigSnapshotRunner(execGit)
  const currentBranchName = await getGitCurrentBranchName(runGit)
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

/** Refresh ahead/behind with one rev-list when branch/config-derived upstream resolution is already cached. */
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
