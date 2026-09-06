import type { GitCommandRunner } from './git-effective-upstream'
import { gitRefTargetsBranchOnRemote } from './git-remote-branch-name'
import { findGitRemoteNameByFetchUrl } from './git-remote-url-index'

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

// One `git remote -v` instead of `git remote` plus a serial `git remote get-url`
// per remote; both print the same insteadOf-expanded fetch URL.
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
  // Why: branch.merge belongs to branch.remote. A pushDefault fork must not
  // inherit origin/main as its destination branch.
  return pushRemote.remote !== 'origin' && pushRemote.branchRemote === pushRemote.remote
}

/**
 * Which remote and refspec a plain `git push` from this worktree should hit, or `null`
 * to fall back to first-publish (`origin HEAD`).
 *
 * Why shared: this decides where commits land, and a wrong answer is not recoverable by
 * retrying. The local runner and the SSH relay must never be able to answer differently
 * for the same repository — they differ only in how `runGit` reaches the Git binary.
 */
export async function resolveConfiguredGitPushTarget(
  runGit: GitCommandRunner
): Promise<ResolvedGitPushTarget | null> {
  try {
    const { stdout: branchStdout } = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const branch = branchStdout.trim()
    if (!branch) {
      return null
    }
    const [pushRemote, { stdout: mergeStdout }] = await Promise.all([
      getConfiguredPushRemote(runGit, branch),
      runGit(['config', '--get', `branch.${branch}.merge`])
    ])
    const remote = pushRemote?.remote
    const mergeRef = mergeStdout.trim()
    const branchRef = mergeRef.replace(/^refs\/heads\//, '')
    if (!remote || !branchRef || remote === '.' || branchRef === mergeRef) {
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
