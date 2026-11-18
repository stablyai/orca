import type { GitCapabilityCache } from '../commands/git-capability-cache'
import { isUnsupportedMergeTreeWriteTreeError } from './git-merge-tree-capability'
import { refreshBranchCleanupTargetRefs } from './git-branch-cleanup-fetch'

export type GitBranchCleanupExecOptions = {
  stdin?: string
  /** The command's object writes are throwaway; run it against a scratch object store. */
  discardWrittenObjects?: boolean
}

export type GitBranchCleanupExec = (
  argv: string[],
  options?: GitBranchCleanupExecOptions
) => Promise<{ stdout: string }>

const SQUASH_PATCH_SCAN_LIMIT = 200

function isLocalTargetRef(ref: string): boolean {
  return ref === 'HEAD' || ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')
}

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

/** `merge-tree --write-tree` exits 1 on a conflict after printing the merged tree's ID first. */
function printedMergedTreeId(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('stdout' in error)) {
    return false
  }
  const firstLine = typeof error.stdout === 'string' ? error.stdout.split('\n', 1)[0].trim() : ''
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(firstLine)
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
        async () => {
          // Why only once supported: an old Git still gets the folder, and Git < 2.35 can't prune a leftover.
          const discardWrittenObjects = capabilities.isKnownSupported('merge-tree-write-tree')
          try {
            return (await runGit(args, { discardWrittenObjects })).stdout.trim() || null
          } catch (error) {
            // Why: a conflict still proves --write-tree ran; returning lets the cache record it.
            if (printedMergedTreeId(error)) {
              return null
            }
            throw error
          }
        },
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
  const stdout = await readOptionalGitStdout(runGit, ['cherry', targetOid, branchRef])
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

function sortedFileSet(lines: string[]): string {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
    .join('\n')
}

/** Patch IDs hash file names, so only commits touching exactly the branch's files can match; null past the scan limit. */
async function listSquashCandidateCommits(
  runGit: GitBranchCleanupExec,
  targetOid: string,
  mergeBase: string,
  branchChangedFiles: string
): Promise<string[] | null> {
  const listing = await readOptionalGitStdout(runGit, [
    'log',
    '--no-show-signature',
    '--format=%x00%H %P',
    '--name-only',
    '--no-renames',
    '--ancestry-path',
    `--max-count=${SQUASH_PATCH_SCAN_LIMIT + 1}`,
    `${mergeBase}..${targetOid}`
  ])
  const entries = listing?.split('\0').filter((entry) => entry.trim()) ?? []
  if (entries.length === 0 || entries.length > SQUASH_PATCH_SCAN_LIMIT) {
    return null
  }
  const branchFiles = sortedFileSet(branchChangedFiles.split(/\r?\n/))
  return entries.flatMap((entry) => {
    const [header = '', ...files] = entry.split(/\r?\n/)
    const [commitOid, ...parents] = header.trim().split(' ')
    // `log` lists no files for merges, so they stay candidates.
    return commitOid && (parents.length > 1 || sortedFileSet(files) === branchFiles)
      ? [commitOid]
      : []
  })
}

async function branchNetPatchMatchesTargetSquashCommit(
  runGit: GitBranchCleanupExec,
  targetOid: string,
  branchRef: string,
  mergeBase: string,
  branchChangedFiles: string,
  capabilities: GitCapabilityCache
): Promise<boolean> {
  const commits = await listSquashCandidateCommits(runGit, targetOid, mergeBase, branchChangedFiles)
  if (!commits?.length) {
    return false
  }
  const branchPatchId = await computeStablePatchId(
    runGit,
    await readOptionalGitRawStdout(runGit, ['diff', mergeBase, branchRef])
  )
  if (!branchPatchId) {
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
    // Shallow/unrelated histories cannot support a merge proof; avoid the expensive tree walk.
    const mergeBase = await readOptionalGitStdout(runGit, ['merge-base', targetOid, branchRef])
    if (!mergeBase) {
      continue
    }
    const branchChanges = await readOptionalGitRawStdout(runGit, [
      'diff',
      '--name-only',
      '--no-renames',
      mergeBase,
      branchRef
    ])
    if (!branchChanges) {
      // An unchanged tree does not prove empty or reverted commits were merged.
      try {
        await runGit(['merge-base', '--is-ancestor', branchRef, targetOid])
      } catch {
        continue
      }
    }
    if (await branchMergesWithoutTreeChanges(runGit, targetOid, branchRef, capabilities)) {
      return true
    }
    if (await hasBranchOnlyMergeCommits(runGit, targetOid, branchRef)) {
      if (
        await branchNetPatchMatchesTargetSquashCommit(
          runGit,
          targetOid,
          branchRef,
          mergeBase,
          branchChanges ?? '',
          capabilities
        )
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

export async function branchHasNoUnmergedChangesWithLazyTargetRefresh(
  runGit: GitBranchCleanupExec,
  branchName: string,
  targetRefs: string[],
  capabilities: GitCapabilityCache
): Promise<boolean> {
  // Why: an unrefreshed remote-tracking ref may no longer represent the remote's branch contents.
  const localTargetRefs = targetRefs.filter(isLocalTargetRef)
  const refreshDependentTargetRefs = targetRefs.filter((targetRef) => !isLocalTargetRef(targetRef))
  if (
    await branchHasNoUnmergedChangesOnAnyTarget(runGit, branchName, localTargetRefs, capabilities)
  ) {
    return true
  }
  const refreshed = await refreshBranchCleanupTargetRefs(runGit, refreshDependentTargetRefs)
  return branchHasNoUnmergedChangesOnAnyTarget(runGit, branchName, refreshed, capabilities)
}
