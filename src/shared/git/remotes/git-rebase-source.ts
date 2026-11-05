// Why: a stalled remote must fail the rebase fetch, not hang the rebase; client and relay share one bound.
export const REBASE_SOURCE_FETCH_TIMEOUT_MS = 60_000
export const REBASE_FROM_BASE_OPERATION_TIMEOUT_MS = REBASE_SOURCE_FETCH_TIMEOUT_MS + 60_000
// Include the process barrier's 2s grace plus its 10s unverified-tree deadline.
export const REBASE_FROM_BASE_RPC_TIMEOUT_MS = REBASE_FROM_BASE_OPERATION_TIMEOUT_MS + 15_000

export type GitCommandRunner = (args: string[]) => Promise<{ stdout: string }>

export type GitRemoteRebaseSource = {
  remoteName: string
  branchName: string
  displayName: string
}

function normalizeBaseRef(baseRef: string): string {
  const trimmed = baseRef.trim()
  if (!trimmed || trimmed.startsWith('-')) {
    throw new Error('Choose a remote base branch to rebase from.')
  }
  if (trimmed.startsWith('refs/remotes/')) {
    return trimmed.slice('refs/remotes/'.length)
  }
  if (trimmed.startsWith('remotes/')) {
    return trimmed.slice('remotes/'.length)
  }
  return trimmed
}

export async function resolveGitRemoteRebaseSource(
  runGit: GitCommandRunner,
  baseRef: string
): Promise<GitRemoteRebaseSource> {
  const normalizedBaseRef = normalizeBaseRef(baseRef)
  const { stdout } = await runGit(['remote'])
  const remotes = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  const remoteName = remotes.find(
    (remote) => normalizedBaseRef !== remote && normalizedBaseRef.startsWith(`${remote}/`)
  )

  if (!remoteName) {
    throw new Error('Choose a remote base branch to rebase from.')
  }

  const branchName = normalizedBaseRef.slice(remoteName.length + 1)
  await runGit(['check-ref-format', '--branch', branchName])

  return {
    remoteName,
    branchName,
    displayName: `${remoteName}/${branchName}`
  }
}
