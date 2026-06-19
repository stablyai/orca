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
