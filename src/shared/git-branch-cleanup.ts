export type GitBranchCleanupExec = (argv: string[]) => Promise<{ stdout: string }>

async function readOptionalGitStdout(
  runGit: GitBranchCleanupExec,
  argv: string[]
): Promise<string | null> {
  try {
    const { stdout } = await runGit(argv)
    return stdout.trim() || null
  } catch {
    return null
  }
}

function addCandidateRef(candidates: string[], ref: string | null): void {
  const trimmed = ref?.trim()
  if (!trimmed || trimmed.startsWith('-') || candidates.includes(trimmed)) {
    return
  }
  candidates.push(trimmed)
}

export async function getBranchCleanupTargetRefs(
  runGit: GitBranchCleanupExec,
  branchName: string
): Promise<string[]> {
  const candidates: string[] = []
  addCandidateRef(
    candidates,
    await readOptionalGitStdout(runGit, ['config', '--get', `branch.${branchName}.base`])
  )
  addCandidateRef(
    candidates,
    await readOptionalGitStdout(runGit, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  )
  addCandidateRef(candidates, 'HEAD')
  return candidates
}

export async function refreshBranchCleanupTargetRefs(
  runGit: GitBranchCleanupExec,
  targetRefs: readonly string[]
): Promise<void> {
  const remotesStdout = await readOptionalGitStdout(runGit, ['remote'])
  const remotes = (remotesStdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((remote) => remote && !remote.startsWith('-'))
    .sort((left, right) => right.length - left.length)
  const fetchedRemotes = new Set<string>()

  for (const targetRef of targetRefs) {
    const remote = remotes.find((candidate) => targetRef.startsWith(`refs/remotes/${candidate}/`))
    if (!remote || fetchedRemotes.has(remote)) {
      continue
    }
    fetchedRemotes.add(remote)
    // Why: deleting a worktree often follows a PR merge. Refresh the saved base
    // before deciding a local branch is unpublished, but keep network failures
    // non-fatal so offline cleanup preserves today's safe behavior.
    await readOptionalGitStdout(runGit, ['fetch', '--prune', remote])
  }
}

async function resolveCommitOid(runGit: GitBranchCleanupExec, ref: string): Promise<string | null> {
  return readOptionalGitStdout(runGit, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
}

async function hasBranchOnlyMergeCommits(
  runGit: GitBranchCleanupExec,
  targetOid: string,
  branchRef: string
): Promise<boolean> {
  const stdout = await readOptionalGitStdout(runGit, [
    'rev-list',
    '--right-only',
    '--merges',
    '--count',
    `${targetOid}...${branchRef}`
  ])
  return Number(stdout ?? 0) > 0
}

async function branchMergesWithoutTreeChanges(
  runGit: GitBranchCleanupExec,
  targetOid: string,
  branchRef: string
): Promise<boolean> {
  const mergedTree = await readOptionalGitStdout(runGit, [
    'merge-tree',
    '--write-tree',
    targetOid,
    branchRef
  ])
  const targetTree = await readOptionalGitStdout(runGit, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${targetOid}^{tree}`
  ])
  return Boolean(mergedTree && targetTree && mergedTree.split(/\r?\n/)[0] === targetTree)
}

async function branchOnlyCommitsArePatchEquivalent(
  runGit: GitBranchCleanupExec,
  targetOid: string,
  branchRef: string
): Promise<boolean> {
  const stdout = await readOptionalGitStdout(runGit, ['cherry', '-v', targetOid, branchRef])
  if (stdout === null) {
    return false
  }
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.every((line) => line.startsWith('-'))
}

export async function branchHasNoUnmergedChangesOnAnyTarget(
  runGit: GitBranchCleanupExec,
  branchName: string,
  targetRefs: string[]
): Promise<boolean> {
  const branchRef = `refs/heads/${branchName}`

  for (const targetRef of targetRefs) {
    const targetOid = await resolveCommitOid(runGit, targetRef)
    if (!targetOid) {
      continue
    }
    if (await branchMergesWithoutTreeChanges(runGit, targetOid, branchRef)) {
      return true
    }
    if (await hasBranchOnlyMergeCommits(runGit, targetOid, branchRef)) {
      continue
    }
    if (await branchOnlyCommitsArePatchEquivalent(runGit, targetOid, branchRef)) {
      return true
    }
  }

  return false
}
