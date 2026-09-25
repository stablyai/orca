export const CARRY_MAX_UNTRACKED_FILES = 2000
export const CARRY_MAX_UNTRACKED_BYTES = 200 * 1024 * 1024

export type WorkingTreeCarryGit = (args: string[], cwd: string) => Promise<string>

export type WorkingTreeCarryIo = {
  git: WorkingTreeCarryGit
  sumEntrySizes: (root: string, relativePaths: readonly string[]) => Promise<number>
  copyEntry: (fromRoot: string, toRoot: string, relativePath: string) => Promise<void>
}

export type WorkingTreeCarryFailureReason =
  | 'base_mismatch'
  | 'target_dirty'
  | 'too_large'
  | 'apply_failed'

export type WorkingTreeCarryResult =
  | { ok: true; trackedChanges: boolean; untrackedCopied: number }
  | { ok: false; reason: WorkingTreeCarryFailureReason; detail?: string }

function splitNulSeparated(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0)
}

// Why: stash create/apply moves tracked edits as git objects (binary-safe, Git 2.25) without touching the source.
export async function carryWorkingTreeChanges(
  io: WorkingTreeCarryIo,
  sourcePath: string,
  targetPath: string
): Promise<WorkingTreeCarryResult> {
  const [sourceHead, targetHead, targetStatus] = await Promise.all([
    io.git(['rev-parse', 'HEAD'], sourcePath),
    io.git(['rev-parse', 'HEAD'], targetPath),
    io.git(['status', '--porcelain'], targetPath)
  ])
  if (sourceHead.trim() !== targetHead.trim()) {
    return { ok: false, reason: 'base_mismatch' }
  }
  if (targetStatus.trim() !== '') {
    return { ok: false, reason: 'target_dirty' }
  }
  const untracked = splitNulSeparated(
    await io.git(['ls-files', '--others', '--exclude-standard', '-z'], sourcePath)
  )
  if (
    untracked.length > CARRY_MAX_UNTRACKED_FILES ||
    (await io.sumEntrySizes(sourcePath, untracked)) > CARRY_MAX_UNTRACKED_BYTES
  ) {
    return { ok: false, reason: 'too_large' }
  }
  const stashCommit = (await io.git(['stash', 'create'], sourcePath)).trim()
  try {
    if (stashCommit) {
      await io.git(['stash', 'apply', stashCommit], targetPath)
      // Why: staging cannot be reproduced faithfully across worktrees, so everything lands unstaged.
      await io.git(['reset', '-q'], targetPath)
    }
    for (const relativePath of untracked) {
      await io.copyEntry(sourcePath, targetPath, relativePath)
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'apply_failed',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  return { ok: true, trackedChanges: stashCommit.length > 0, untrackedCopied: untracked.length }
}
