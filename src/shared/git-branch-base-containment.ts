export type GitBranchBaseRunner = (argv: string[]) => Promise<{ stdout: string }>

const COMMIT_OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/i

async function readTrimmedStdout(runGit: GitBranchBaseRunner, argv: string[]): Promise<string> {
  try {
    return (await runGit(argv)).stdout.trim()
  } catch {
    return ''
  }
}

/**
 * The full ref name a candidate resolves to, following symbolic refs, so one that is the branch
 * itself is recognised: a bare repo's HEAD names a branch without checking it out, so nothing else
 * refuses it, and a branch always holds its own head. A commit id, a missing ref or a detached HEAD
 * gives '': none is a branch that keeps the commits once this one is gone.
 */
async function resolveBaseRef(runGit: GitBranchBaseRunner, candidate: string): Promise<string> {
  if (!candidate || candidate.startsWith('-')) {
    return ''
  }
  const fullName = await readTrimmedStdout(runGit, ['rev-parse', '--symbolic-full-name', candidate])
  return fullName === 'HEAD' ? '' : fullName
}

/**
 * Refs whose history a removed workspace's branch was cut from: its saved creation base, the
 * remote's default branch, and the branch the main checkout's HEAD names, each resolved to what it
 * names and never the branch itself. Local reads only; nothing is fetched.
 */
export async function readBranchBaseRefs(
  runGit: GitBranchBaseRunner,
  branchName: string
): Promise<string[]> {
  const savedBase = await readTrimmedStdout(runGit, [
    'config',
    '--get',
    `branch.${branchName}.base`
  ])
  // Why HEAD: with an upstream set, `branch -d` compares against the upstream only.
  const candidates: string[] = []
  for (const candidate of [savedBase, 'refs/remotes/origin/HEAD', 'HEAD']) {
    candidates.push(await resolveBaseRef(runGit, candidate))
  }
  // Why case-insensitive: on macOS and Windows `refs/heads/feat` opens the ref file of `Feat`.
  const ownRef = `refs/heads/${branchName}`.toLowerCase()
  return candidates.filter(
    (ref, index) =>
      ref &&
      !ref.startsWith('-') &&
      ref.toLowerCase() !== ownRef &&
      candidates.indexOf(ref) === index
  )
}

/**
 * True when `head` is in the history of a ref the branch was cut from, so deleting the branch
 * drops no commit. Orca creates workspace branches with `--no-track`, which makes `branch -d`
 * compare against the main checkout's HEAD instead: a workspace with no commits of its own is
 * refused when that HEAD is behind its base or on another branch.
 */
export async function isBranchHeadInBaseHistory(
  runGit: GitBranchBaseRunner,
  branchName: string,
  head: string
): Promise<boolean> {
  if (!COMMIT_OID.test(head)) {
    return false
  }
  for (const ref of await readBranchBaseRefs(runGit, branchName)) {
    try {
      // Exit 1 (not an ancestor) and a missing ref both throw.
      await runGit(['merge-base', '--is-ancestor', head, ref])
      return true
    } catch {
      // Try the next ref.
    }
  }
  return false
}
