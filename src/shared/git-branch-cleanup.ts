import type { GitCapabilityCache } from './git-capability-cache'
import { isUnsupportedMergeTreeWriteTreeError } from './git-merge-tree-capability'

export type GitBranchCleanupExec = (
  argv: string[],
  options?: { stdin?: string }
) => Promise<{ stdout: string }>

const SQUASH_PATCH_SCAN_LIMIT = 200

async function readOptionalGitStdout(
  runGit: GitBranchCleanupExec,
  argv: string[],
  options?: { stdin?: string }
): Promise<string | null> {
  try {
    const { stdout } = await runGit(argv, options)
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function readOptionalGitRawStdout(
  runGit: GitBranchCleanupExec,
  argv: string[]
): Promise<string | null> {
  try {
    const { stdout } = await runGit(argv)
    return stdout || null
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
  branchRef: string,
  capabilities: GitCapabilityCache
): Promise<boolean> {
  const args = ['merge-tree', '--write-tree', targetOid, branchRef]
  const readMergedTree = async (): Promise<string | null> => {
    try {
      return await capabilities.runWithFallback(
        'merge-tree-write-tree',
        async () => (await runGit(args)).stdout.trim() || null,
        async () => null,
        isUnsupportedMergeTreeWriteTreeError
      )
    } catch {
      return null
    }
  }
  const mergedTree = await readMergedTree()
  if (!mergedTree) {
    return false
  }
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

function parsePatchId(stdout: string | null): string | null {
  const line = stdout
    ?.split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(Boolean)
  const patchId = line?.split(/\s+/)[0]
  return patchId || null
}

async function computeStablePatchId(
  runGit: GitBranchCleanupExec,
  patchText: string | null
): Promise<string | null> {
  if (!patchText) {
    return null
  }
  return parsePatchId(
    await readOptionalGitStdout(runGit, ['patch-id', '--stable'], { stdin: patchText })
  )
}

async function branchNetPatchMatchesTargetSquashCommit(
  runGit: GitBranchCleanupExec,
  targetOid: string,
  branchRef: string,
  capabilities: GitCapabilityCache
): Promise<boolean> {
  const mergeBase = await readOptionalGitStdout(runGit, ['merge-base', targetOid, branchRef])
  if (!mergeBase) {
    return false
  }

  const branchPatchId = await computeStablePatchId(
    runGit,
    await readOptionalGitRawStdout(runGit, ['diff', mergeBase, branchRef])
  )
  if (!branchPatchId) {
    return false
  }

  const commits = (
    await readOptionalGitStdout(runGit, [
      'rev-list',
      '--ancestry-path',
      `--max-count=${SQUASH_PATCH_SCAN_LIMIT + 1}`,
      `${mergeBase}..${targetOid}`
    ])
  )
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!commits?.length || commits.length > SQUASH_PATCH_SCAN_LIMIT) {
    return false
  }

  for (const commitOid of commits) {
    const commitPatchId = await computeStablePatchId(
      runGit,
      await readOptionalGitRawStdout(runGit, ['show', '--format=', commitOid])
    )
    // Why: a matching patch-id identifies a possible squash commit, but the
    // tree merge proves the branch contributes no additional changes there.
    if (
      commitPatchId === branchPatchId &&
      (await branchMergesWithoutTreeChanges(runGit, commitOid, branchRef, capabilities))
    ) {
      return true
    }
  }
  return false
}

export async function branchHasNoUnmergedChangesOnAnyTarget(
  runGit: GitBranchCleanupExec,
  branchName: string,
  targetRefs: string[],
  capabilities: GitCapabilityCache
): Promise<boolean> {
  const branchRef = `refs/heads/${branchName}`

  for (const targetRef of targetRefs) {
    const targetOid = await resolveCommitOid(runGit, targetRef)
    if (!targetOid) {
      continue
    }
    if (await branchMergesWithoutTreeChanges(runGit, targetOid, branchRef, capabilities)) {
      return true
    }
    if (await hasBranchOnlyMergeCommits(runGit, targetOid, branchRef)) {
      if (
        await branchNetPatchMatchesTargetSquashCommit(runGit, targetOid, branchRef, capabilities)
      ) {
        return true
      }
      continue
    }
    if (await branchOnlyCommitsArePatchEquivalent(runGit, targetOid, branchRef)) {
      return true
    }
  }

  return false
}
