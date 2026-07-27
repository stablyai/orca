const HEADS_REF_PREFIX = 'refs/heads/'

/**
 * Argv that reads HEAD's full symref. Never add `--short`: it returns the
 * shortest *unambiguous* ref, so any other ref sharing the branch's name (most
 * commonly a same-named tag) abbreviates HEAD to `heads/<name>`. No
 * `branch.<name>.*` config key, `refs/remotes/<remote>/<name>` probe, or
 * `refs/heads/<name>` path matches that string, so every downstream lookup
 * silently misses.
 */
export const GIT_CURRENT_BRANCH_REF_ARGS: readonly string[] = ['symbolic-ref', '--quiet', 'HEAD']

/**
 * Branch name from `GIT_CURRENT_BRANCH_REF_ARGS` stdout, or `null` when HEAD is
 * detached (git exits non-zero and prints nothing).
 */
export function branchNameFromHeadRef(headRefStdout: string): string | null {
  const ref = headRefStdout.trim()
  if (!ref) {
    return null
  }
  // Why conditional: a HEAD symref outside refs/heads/ passes through unmangled
  // rather than being silently reinterpreted as a branch name.
  return ref.startsWith(HEADS_REF_PREFIX) ? ref.slice(HEADS_REF_PREFIX.length) : ref
}

/**
 * Current branch name, or `null` on a detached HEAD. Every caller that keys git
 * config or ref paths by the current branch must read it through here.
 */
export async function readGitCurrentBranchName(
  runGit: (args: string[]) => Promise<{ stdout: string }>
): Promise<string | null> {
  try {
    const { stdout } = await runGit([...GIT_CURRENT_BRANCH_REF_ARGS])
    return branchNameFromHeadRef(stdout)
  } catch {
    return null
  }
}
