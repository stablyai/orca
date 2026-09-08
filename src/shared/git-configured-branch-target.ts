import {
  gitBranchNameFromFullRef,
  gitUpstreamIdentity,
  gitTrackingRefDisplayName
} from './git-upstream-identity'
import { gitOperationSelector, type GitOperationSelector } from './git-operation-selector'
import { gitRefTargetsBranchOnRemote } from './git-remote-branch-name'
import { findGitRemoteNameByFetchUrl, parseGitRemoteVerboseLine } from './git-remote-url-index'

type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

type RemoteTrackingRef = (remoteName: string, branchName: string) => Promise<string | null>

export type ConfiguredBranchRemoteUpstream = {
  operationSelector: GitOperationSelector
  upstreamRef: string | null
  upstreamName: string | null
  remoteName: string
  branchName: string
  mergeRef: string
  isConfiguredUpstream: false
}

async function getGitConfigValue(
  runGit: GitCommandRunner,
  key: string,
  strict = false
): Promise<string | null> {
  try {
    const { stdout } = await runGit(['config', '--get', key])
    const value = stdout.trim()
    return value || null
  } catch (error) {
    if (strict && (error as { code?: unknown } | null)?.code !== 1) {
      throw error
    }
    return null
  }
}

export async function getConfiguredBranchRemoteUpstream(
  runGit: GitCommandRunner,
  currentBranchName: string,
  remoteTrackingRef: RemoteTrackingRef
): Promise<ConfiguredBranchRemoteUpstream | null> {
  const [remote, mergeRef, baseRef] = await Promise.all([
    getGitConfigValue(runGit, `branch.${currentBranchName}.remote`, true),
    getGitConfigValue(runGit, `branch.${currentBranchName}.merge`, true),
    getGitConfigValue(runGit, `branch.${currentBranchName}.base`, true)
  ])
  if (!remote || remote === '.') {
    return null
  }

  const { stdout } = await runGit(['remote', '-v'])
  const remoteNames = stdout.split('\n').flatMap((line) => {
    const entry = parseGitRemoteVerboseLine(line)
    return entry ? [entry.name] : []
  })
  const operationSelector = gitOperationSelector(remote, remoteNames)
  const identity = gitUpstreamIdentity(operationSelector, mergeRef)
  if (!identity) {
    return null
  }
  const { branchName } = identity
  const remoteName =
    operationSelector.kind === 'named-remote'
      ? remote
      : findGitRemoteNameByFetchUrl(stdout, (candidate) => candidate === remote)
  // Preserve the explicit legacy base marker policy, not URL-to-name operation authority.
  if (remoteName && gitRefTargetsBranchOnRemote(baseRef, remoteName, branchName)) {
    return null
  }
  const trackingRef =
    operationSelector.kind === 'named-remote' ? await remoteTrackingRef(remote, branchName) : null
  return {
    operationSelector,
    upstreamRef: trackingRef,
    upstreamName: trackingRef ? gitTrackingRefDisplayName(trackingRef) : null,
    remoteName: remoteName ?? remote,
    branchName,
    mergeRef: identity.mergeRef,
    isConfiguredUpstream: false
  }
}

export async function hasConfiguredBranchPushTarget(
  runGit: GitCommandRunner,
  currentBranchName: string
): Promise<boolean> {
  const [pushRemote, pushDefault, branchRemote, mergeRef, baseRef] = await Promise.all([
    getGitConfigValue(runGit, `branch.${currentBranchName}.pushRemote`),
    getGitConfigValue(runGit, 'remote.pushDefault'),
    getGitConfigValue(runGit, `branch.${currentBranchName}.remote`),
    getGitConfigValue(runGit, `branch.${currentBranchName}.merge`),
    getGitConfigValue(runGit, `branch.${currentBranchName}.base`)
  ])
  const remote = pushRemote ?? pushDefault ?? branchRemote
  const branchName = gitBranchNameFromFullRef(mergeRef)
  if (!remote || remote === '.' || !branchName || branchName === mergeRef) {
    return false
  }
  if (gitRefTargetsBranchOnRemote(baseRef, remote, branchName)) {
    return false
  }
  // Why: branch.merge belongs to branch.remote. Do not combine a user's
  // pushDefault fork with an origin/main merge target and call it pushable.
  if (branchName !== currentBranchName && (remote === 'origin' || branchRemote !== remote)) {
    return false
  }
  return true
}
