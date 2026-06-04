import { isNoUpstreamError } from './git-remote-error'
import type { GitUpstreamStatus } from './types'

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

export function splitRemoteBranchName(refName: string): {
  remoteName: string
  branchName: string
} | null {
  const slashIndex = refName.indexOf('/')
  if (slashIndex <= 0 || slashIndex === refName.length - 1) {
    return null
  }
  return {
    remoteName: refName.slice(0, slashIndex),
    branchName: refName.slice(slashIndex + 1)
  }
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
    const remotes = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
    return (
      remotes
        .map((remoteName) => {
          if (refName === remoteName || !refName.startsWith(`${remoteName}/`)) {
            return null
          }
          const branchName = refName.slice(remoteName.length + 1)
          return branchName ? { remoteName, branchName } : null
        })
        .find((parsed) => parsed !== null) ?? null
    )
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

export async function resolveEffectiveGitUpstream(
  runGit: GitCommandRunner
): Promise<EffectiveGitUpstream | null> {
  const currentBranchName = await getCurrentBranchName(runGit)
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

export async function getEffectiveGitUpstreamStatus(
  runGit: GitCommandRunner,
  getBehindCommitsArePatchEquivalent?: (upstreamName: string) => Promise<boolean>
): Promise<GitUpstreamStatus> {
  const upstream = await resolveEffectiveGitUpstream(runGit)
  if (!upstream) {
    return { hasUpstream: false, ahead: 0, behind: 0 }
  }

  const { stdout } = await runGit([
    'rev-list',
    '--left-right',
    '--count',
    `HEAD...${upstream.upstreamName}`
  ])
  const tokens = stdout.trim().split(/\s+/)
  if (tokens.length !== 2) {
    throw new Error(`Unexpected git rev-list output: ${JSON.stringify(stdout)}`)
  }

  const ahead = Number.parseInt(tokens[0]!, 10)
  const behind = Number.parseInt(tokens[1]!, 10)
  if (!Number.isFinite(ahead) || !Number.isFinite(behind) || ahead < 0 || behind < 0) {
    throw new Error(`Unparseable git rev-list counts: ${JSON.stringify(stdout)}`)
  }

  const behindCommitsArePatchEquivalent =
    ahead > 0 && behind > 0 && getBehindCommitsArePatchEquivalent
      ? await getBehindCommitsArePatchEquivalent(upstream.upstreamName)
      : undefined

  return {
    hasUpstream: true,
    upstreamName: upstream.upstreamName,
    ahead,
    behind,
    ...(behindCommitsArePatchEquivalent !== undefined ? { behindCommitsArePatchEquivalent } : {})
  }
}
