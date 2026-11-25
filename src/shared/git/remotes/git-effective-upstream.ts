import type { DivergedUpstreamProbe } from './git-upstream-status'
import { isNoUpstreamError } from './git-remote-error'
import type { GitUpstreamStatus } from '../status/git-status-types'
import {
  getConfiguredBranchRemoteUpstream,
  hasConfiguredBranchPushTarget
} from './git-configured-branch-target'
import { splitRemoteBranchName } from './git-remote-branch-name'
import { parseGitRevListAheadBehindCounts } from '../refs/git-rev-list-output'
import { iterateProcessOutputLines } from '../../process-observation/process-output-field-scanner'
import { createGitConfigSnapshotRunner } from '../commands/git-config-snapshot-runner'
import { getGitCurrentBranchName } from '../refs/git-current-branch'

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

export async function splitRemoteBranchNameByKnownRemote(
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

async function getConfiguredUpstream(
  runGit: GitCommandRunner
): Promise<EffectiveGitUpstream | null> {
  try {
    // Why: --abbrev-ref prints remotes/origin/main when a local branch or tag is named origin/main,
    // so split the full ref and keep Git's unambiguous short name for revision arguments.
    const { stdout } = await runGit([
      'rev-parse',
      '--symbolic-full-name',
      'HEAD@{u}',
      '--abbrev-ref',
      'HEAD@{u}'
    ])
    const [fullName = '', upstreamName = ''] = stdout.split(/\r?\n/).map((line) => line.trim())
    if (!upstreamName) {
      return null
    }
    const localBranchName = stripRefPrefix(fullName, 'refs/heads/')
    const parsed =
      localBranchName === null
        ? splitRemoteBranchName(stripRefPrefix(fullName, 'refs/remotes/') ?? upstreamName)
        : null
    return {
      upstreamName,
      remoteName: parsed?.remoteName ?? null,
      branchName: parsed?.branchName ?? localBranchName ?? upstreamName,
      isConfiguredUpstream: true
    }
  } catch (error) {
    if (isNoUpstreamError(error)) {
      return null
    }
    throw error
  }
}

function stripRefPrefix(refName: string, prefix: string): string | null {
  return refName.startsWith(prefix) ? refName.slice(prefix.length) : null
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
      configured.branchName.includes('/')
    ) {
      const parsed = await splitRemoteBranchNameByKnownRemote(
        runGit,
        `${configured.remoteName}/${configured.branchName}`
      )
      if (parsed) {
        configured = { ...configured, ...parsed }
      }
    }

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
  probeDivergedUpstream?: (upstreamName: string) => Promise<DivergedUpstreamProbe>
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

  return getGitUpstreamStatusForUpstreamName(runGit, upstream.upstreamName, probeDivergedUpstream)
}

/** Refresh ahead/behind with one rev-list when branch/config-derived upstream resolution is already cached. */
export async function getGitUpstreamStatusForUpstreamName(
  runGit: GitCommandRunner,
  upstreamName: string,
  probeDivergedUpstream?: (upstreamName: string) => Promise<DivergedUpstreamProbe>
): Promise<GitUpstreamStatus> {
  const { stdout } = await runGit(['rev-list', '--left-right', '--count', `HEAD...${upstreamName}`])
  const counts = parseGitRevListAheadBehindCounts(stdout)
  if (counts.status === 'unexpected-field-count') {
    throw new Error(`Unexpected git rev-list output: ${JSON.stringify(stdout)}`)
  }
  if (counts.status === 'unparseable-counts') {
    throw new Error(`Unparseable git rev-list counts: ${JSON.stringify(stdout)}`)
  }

  const diverged =
    counts.ahead > 0 && counts.behind > 0 && probeDivergedUpstream
      ? await probeDivergedUpstream(upstreamName)
      : undefined

  return {
    hasUpstream: true,
    upstreamName,
    ahead: counts.ahead,
    behind: counts.behind,
    ...(diverged
      ? {
          behindCommitsArePatchEquivalent: diverged.behindCommitsArePatchEquivalent,
          ...(diverged.upstreamOid ? { upstreamOid: diverged.upstreamOid } : {})
        }
      : {})
  }
}
