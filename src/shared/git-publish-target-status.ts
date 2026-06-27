import type { GitUpstreamStatus } from './git-status-types'
import type { GitPushTarget } from './types'
import { parseGitRevListAheadBehindCounts } from './git-rev-list-output'

export type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

export function getPublishTargetDisplayName(target: GitPushTarget): string {
  return `${target.remoteName}/${target.branchName}`
}

export function getPublishTargetRemoteRef(target: GitPushTarget): string {
  return `refs/remotes/${target.remoteName}/${target.branchName}`
}

function isMissingRemoteTrackingRefError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const candidate = error as Error & { code?: unknown; stderr?: unknown }
  const stderr = typeof candidate.stderr === 'string' ? candidate.stderr.trim() : ''
  if (stderr.length > 0) {
    return false
  }
  return candidate.code === 1 || /(?:exited with|exit code) 1\b/i.test(candidate.message)
}

export async function getPublishTargetStatus(
  runGit: GitCommandRunner,
  target: GitPushTarget,
  getBehindCommitsArePatchEquivalent?: (upstreamName: string) => Promise<boolean>
): Promise<GitUpstreamStatus> {
  const upstreamName = getPublishTargetDisplayName(target)
  const remoteRef = getPublishTargetRemoteRef(target)

  try {
    await runGit(['rev-parse', '--verify', '--quiet', remoteRef])
  } catch (error) {
    if (!isMissingRemoteTrackingRefError(error)) {
      throw error
    }
    return {
      hasUpstream: false,
      upstreamName,
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    }
  }

  const { stdout } = await runGit(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`])
  const counts = parseGitRevListAheadBehindCounts(stdout)
  if (counts.status === 'unexpected-field-count') {
    throw new Error(`Unexpected git rev-list output: ${JSON.stringify(stdout)}`)
  }
  if (counts.status === 'unparseable-counts') {
    throw new Error(`Unparseable git rev-list counts: ${JSON.stringify(stdout)}`)
  }

  const behindCommitsArePatchEquivalent =
    counts.ahead > 0 && counts.behind > 0 && getBehindCommitsArePatchEquivalent
      ? await getBehindCommitsArePatchEquivalent(remoteRef)
      : undefined

  return {
    hasUpstream: true,
    upstreamName,
    ahead: counts.ahead,
    behind: counts.behind,
    ...(behindCommitsArePatchEquivalent !== undefined ? { behindCommitsArePatchEquivalent } : {})
  }
}
