import type { GitCommandRunner } from './git-effective-upstream'
import { gitRefTargetsBranchOnRemote } from './git-remote-branch-name'
import { findGitRemoteNameByFetchUrl } from './git-remote-url-index'
import { createGitConfigSnapshotRunner } from './git-config-snapshot-runner'
import { getGitCurrentBranchName } from './git-current-branch'

export type ResolvedGitPushTarget = {
  remote: string
  refspec: string
}

async function getConfigValue(runGit: GitCommandRunner, key: string): Promise<string | null> {
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

type ConfiguredPushRemote = {
  remote: string
  branchRemote: string | null
}

// remote -v replaces serial per-remote get-url calls while preserving insteadOf-expanded fetch URLs.
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

async function normalizePushRemote(runGit: GitCommandRunner, remote: string): Promise<string> {
  if (!isUrlValuedRemote(remote)) {
    return remote
  }
  return (await findRemoteNameForUrl(runGit, remote)) ?? remote
}

async function getConfiguredPushRemote(
  runGit: GitCommandRunner,
  branch: string
): Promise<ConfiguredPushRemote | null> {
  const branchRemote = await getConfigValue(runGit, `branch.${branch}.remote`)
  const remote =
    (await getConfigValue(runGit, `branch.${branch}.pushRemote`)) ??
    (await getConfigValue(runGit, 'remote.pushDefault')) ??
    branchRemote
  if (!remote) {
    return null
  }
  const normalizedRemote = await normalizePushRemote(runGit, remote)
  // The two usually name the same URL; resolving it twice reads the remote table twice.
  if (!branchRemote) {
    return { remote: normalizedRemote, branchRemote: null }
  }
  return {
    remote: normalizedRemote,
    branchRemote:
      branchRemote === remote ? normalizedRemote : await normalizePushRemote(runGit, branchRemote)
  }
}

async function branchMergeTargetsConfiguredBase(
  runGit: GitCommandRunner,
  branch: string,
  remote: string,
  branchRef: string
): Promise<boolean> {
  return gitRefTargetsBranchOnRemote(
    await getConfigValue(runGit, `branch.${branch}.base`),
    remote,
    branchRef
  )
}

function canPushConfiguredMergeBranch(
  pushRemote: ConfiguredPushRemote | null,
  branch: string,
  branchRef: string
): boolean {
  if (!pushRemote) {
    return false
  }
  if (branchRef === branch) {
    return true
  }
  // branch.merge belongs to branch.remote; pushDefault forks cannot inherit origin/main as their destination.
  return pushRemote.remote !== 'origin' && pushRemote.branchRemote === pushRemote.remote
}

/** Resolve plain-push remote/refspec, or null for first publish (origin HEAD).
 * Share local/SSH routing: an incorrect destination cannot be repaired by retrying. */
export async function resolveConfiguredGitPushTarget(
  execGit: GitCommandRunner
): Promise<ResolvedGitPushTarget | null> {
  const runGit = createGitConfigSnapshotRunner(execGit)
  try {
    const branch = await getGitCurrentBranchName(runGit)
    if (!branch) {
      return null
    }
    const [pushRemote, mergeRef] = await Promise.all([
      getConfiguredPushRemote(runGit, branch),
      getConfigValue(runGit, `branch.${branch}.merge`)
    ])
    const remote = pushRemote?.remote
    if (!remote || remote === '.') {
      return null
    }
    if (!mergeRef) {
      return { remote, refspec: 'HEAD' }
    }
    const branchRef = mergeRef.replace(/^refs\/heads\//, '')
    if (!branchRef || branchRef === mergeRef) {
      return null
    }
    if (await branchMergeTargetsConfiguredBase(runGit, branch, remote, branchRef)) {
      return null
    }
    if (!canPushConfiguredMergeBranch(pushRemote, branch, branchRef)) {
      return null
    }
    return { remote, refspec: `HEAD:${branchRef}` }
  } catch {
    return null
  }
}
