import { gitBranchNameFromFullRef } from './git-upstream-identity'
import { readCurrentGitBranchName } from './git-current-branch'
import type { GitCommandRunner } from './git-effective-upstream'
import { gitRefTargetsBranchOnRemote } from './git-remote-branch-name'

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

type ConfiguredPushRemote = {
  remote: string
  branchRemote: string | null
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
  return { remote, branchRemote }
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
    const branch = await readCurrentGitBranchName(runGit)
    if (!branch) {
      return null
    }
    const [pushRemote, { stdout: mergeStdout }] = await Promise.all([
      getConfiguredPushRemote(runGit, branch),
      runGit(['config', '--get', `branch.${branch}.merge`])
    ])
    const remote = pushRemote?.remote
    const mergeRef = mergeStdout.trim()
    const branchRef = gitBranchNameFromFullRef(mergeRef)
    if (!remote || !branchRef || remote === '.') {
      return null
    }
    if (await branchMergeTargetsConfiguredBase(runGit, branch, remote, branchRef)) {
      return null
    }
    if (!canPushConfiguredMergeBranch(pushRemote, branch, branchRef)) {
      return null
    }
    return { remote, refspec: `HEAD:${mergeRef}` }
  } catch {
    return null
  }
}
