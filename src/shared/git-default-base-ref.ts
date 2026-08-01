/** Callback shape for a git exec function that yields stdout. */
export type GitExec = (argv: string[]) => Promise<{ stdout: string }>

/**
 * Ordered probe list for a repo's default base ref when no origin/HEAD symbolic-ref is set.
 * `returnAs` is the short-name format the UI expects (as `for-each-ref --format=%(refname:short)` renders it).
 * Shared local/SSH so both resolve identical defaults.
 */
export const DEFAULT_BASE_REF_PROBES: readonly { ref: string; returnAs: string }[] = [
  { ref: 'refs/remotes/origin/main', returnAs: 'origin/main' },
  { ref: 'refs/remotes/origin/master', returnAs: 'origin/master' },
  { ref: 'refs/heads/main', returnAs: 'main' },
  { ref: 'refs/heads/master', returnAs: 'master' }
]

export function gitRefToDefaultBaseRef(ref: string): string {
  return ref.replace(/^refs\/remotes\//, '')
}

export function normalizeLocalBranchRef(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

/**
 * Walk DEFAULT_BASE_REF_PROBES in order, returning the first ref `hasRef` confirms, or null.
 * Abstracts the existence test so local and SSH paths share one authoritative probe ordering.
 */
export async function resolveDefaultBaseRefFromProbes(
  hasRef: (ref: string) => Promise<boolean>
): Promise<string | null> {
  for (const { ref, returnAs } of DEFAULT_BASE_REF_PROBES) {
    if (await hasRef(ref)) {
      return returnAs
    }
  }
  return null
}

async function hasGitRefViaExec(exec: GitExec, ref: string): Promise<boolean> {
  try {
    await exec(['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

async function resolveVerifiedOriginHeadBaseRefViaExec(exec: GitExec): Promise<string | null> {
  try {
    const { stdout } = await exec(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    const ref = stdout.trim()
    if (!ref || !(await hasGitRefViaExec(exec, ref))) {
      return null
    }
    return gitRefToDefaultBaseRef(ref)
  } catch {
    return null
  }
}

/**
 * Resolve the default base ref via a git exec callback: prefer origin/HEAD's symbolic-ref target,
 * else fall back to DEFAULT_BASE_REF_PROBES. Shared local/SSH so both transports agree.
 *
 * Why swallow symbolic-ref's error: a non-zero exit is the expected "origin/HEAD unset" signal, not a failure.
 */
export async function resolveDefaultBaseRefViaExec(exec: GitExec): Promise<string | null> {
  const originHeadBaseRef = await resolveVerifiedOriginHeadBaseRefViaExec(exec)
  if (originHeadBaseRef) {
    return originHeadBaseRef
  }
  return resolveDefaultBaseRefFromProbes((ref) => hasGitRefViaExec(exec, ref))
}

/**
 * Whether `branchName` is this repo's default branch, per the same resolution every
 * other Orca surface uses. `init.defaultBranch` is a last resort for repos where no
 * ref resolves at all (no remote, no main/master).
 */
export async function isRepoDefaultBranch(exec: GitExec, branchName: string): Promise<boolean> {
  const branch = normalizeLocalBranchRef(branchName)
  if (!branch) {
    return false
  }
  const defaultBaseRef = await resolveDefaultBaseRefViaExec(exec)
  if (defaultBaseRef) {
    return defaultBaseRef.replace(/^origin\//, '') === branch
  }
  try {
    const { stdout } = await exec(['config', '--get', 'init.defaultBranch'])
    return stdout.trim() === branch
  } catch {
    return false
  }
}
