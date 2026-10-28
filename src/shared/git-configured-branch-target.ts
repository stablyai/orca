import { gitRefTargetsBranchOnRemote } from './git-remote-branch-name'
import { findGitRemoteNameByFetchUrl } from './git-remote-url-index'

type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

type RemoteTrackingRefExists = (remoteName: string, branchName: string) => Promise<boolean>

export type ConfiguredBranchRemoteUpstream = {
  upstreamName: string
  remoteName: string
  branchName: string
  isConfiguredUpstream: false
}

async function getGitConfigValue(runGit: GitCommandRunner, key: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['config', '--get', key])
    const value = stdout.trim()
    return value || null
  } catch {
    return null
  }
}

function isUrlValuedRemote(remote: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote) || /^[^@/:]+@[^:]+:.+/.test(remote)
}

// Two URL-valued remotes formerly cost up to 2 × (1 + remotes) subprocesses.
async function findRemoteNameForUrl(
  runGit: GitCommandRunner,
  remoteUrl: string
): Promise<string | null> {
  try {
    const { stdout } = await runGit(['remote', '-v'])
    return findGitRemoteNameByFetchUrl(stdout, (candidateUrl) => candidateUrl === remoteUrl)
  } catch {
    return null
  }
}

export async function getConfiguredBranchRemoteUpstream(
  runGit: GitCommandRunner,
  currentBranchName: string,
  remoteTrackingRefExists: RemoteTrackingRefExists
): Promise<ConfiguredBranchRemoteUpstream | null> {
  const [remote, mergeRef, baseRef] = await Promise.all([
    getGitConfigValue(runGit, `branch.${currentBranchName}.remote`),
    getGitConfigValue(runGit, `branch.${currentBranchName}.merge`),
    getGitConfigValue(runGit, `branch.${currentBranchName}.base`)
  ])
  const branchName = mergeRef?.replace(/^refs\/heads\//, '') ?? ''
  if (!remote || !branchName || branchName === mergeRef || remote === '.') {
    return null
  }

  const remoteName = isUrlValuedRemote(remote) ? await findRemoteNameForUrl(runGit, remote) : remote
  if (
    !remoteName ||
    gitRefTargetsBranchOnRemote(baseRef, remoteName, branchName) ||
    !(await remoteTrackingRefExists(remoteName, branchName))
  ) {
    return null
  }
  return {
    upstreamName: `${remoteName}/${branchName}`,
    remoteName,
    branchName,
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
  const branchName = mergeRef?.replace(/^refs\/heads\//, '') ?? ''
  if (!remote || remote === '.' || !branchName || branchName === mergeRef) {
    return false
  }
  const pushRemoteName = isUrlValuedRemote(remote)
    ? ((await findRemoteNameForUrl(runGit, remote)) ?? remote)
    : remote
  // The two usually name the same URL; resolving it twice reads the remote table twice.
  const branchRemoteName = !branchRemote
    ? null
    : branchRemote === remote
      ? pushRemoteName
      : isUrlValuedRemote(branchRemote)
        ? ((await findRemoteNameForUrl(runGit, branchRemote)) ?? branchRemote)
        : branchRemote
  if (gitRefTargetsBranchOnRemote(baseRef, pushRemoteName, branchName)) {
    return false
  }
  // branch.merge belongs to branch.remote; pushDefault forks cannot borrow origin/main to become pushable.
  if (
    branchName !== currentBranchName &&
    (pushRemoteName === 'origin' || branchRemoteName !== pushRemoteName)
  ) {
    return false
  }
  return true
}
