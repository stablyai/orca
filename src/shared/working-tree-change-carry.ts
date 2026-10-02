export const CARRY_MAX_UNTRACKED_FILES = 2000
export const CARRY_MAX_UNTRACKED_BYTES = 200 * 1024 * 1024

export type WorkingTreeCarryGit = (args: string[], cwd: string) => Promise<string>

export type WorkingTreeCarryIo = {
  git: WorkingTreeCarryGit
  sumEntrySizes: (root: string, relativePaths: readonly string[]) => Promise<number>
  copyEntry: (fromRoot: string, toRoot: string, relativePath: string) => Promise<void>
  removeEntry: (root: string, relativePath: string) => Promise<void>
  entryExists: (root: string, relativePath: string) => Promise<boolean>
}

export type WorkingTreeCarryFailureReason =
  | 'base_mismatch'
  | 'target_dirty'
  | 'too_large'
  | 'apply_failed'
  | 'partially_applied'

export type WorkingTreeCarryResult =
  | { ok: true; trackedChanges: boolean; untrackedCopied: number }
  | { ok: false; reason: WorkingTreeCarryFailureReason; detail?: string }

function splitNulSeparated(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0)
}

// Why: git lists an untracked nested repo/in-tree worktree as one entry ending in '/', not its contents.
function isNestedRepositoryEntry(relativePath: string): boolean {
  return relativePath.endsWith('/')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

// Why: reset --hard restores tracked state but leaves stash-added/copied paths untracked, so remove them explicitly.
async function rollBackTarget(
  io: WorkingTreeCarryIo,
  targetPath: string,
  writtenPaths: readonly string[],
  originalError: unknown
): Promise<WorkingTreeCarryResult> {
  const originalMessage = errorMessage(originalError)
  try {
    // Why: removal runs first; a tracked symlink restored by reset would route these paths outside the target.
    for (const relativePath of writtenPaths) {
      await io.removeEntry(targetPath, relativePath)
    }
    await io.git(['reset', '-q', '--hard', 'HEAD'], targetPath)
  } catch (rollbackError) {
    return {
      ok: false,
      reason: 'partially_applied',
      detail: `carry failed: ${originalMessage}; rollback failed: ${errorMessage(rollbackError)}`
    }
  }
  return { ok: false, reason: 'apply_failed', detail: originalMessage }
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
    // Why: --untracked-files=normal overrides a local status.showUntrackedFiles=no config.
    io.git(['status', '--porcelain', '--untracked-files=normal'], targetPath)
  ])
  if (sourceHead.trim() !== targetHead.trim()) {
    return { ok: false, reason: 'base_mismatch' }
  }
  if (targetStatus.trim() !== '') {
    return { ok: false, reason: 'target_dirty' }
  }
  const untracked = splitNulSeparated(
    await io.git(['ls-files', '--others', '--exclude-standard', '-z'], sourcePath)
  ).filter((entry) => !isNestedRepositoryEntry(entry))
  if (
    untracked.length > CARRY_MAX_UNTRACKED_FILES ||
    (await io.sumEntrySizes(sourcePath, untracked)) > CARRY_MAX_UNTRACKED_BYTES
  ) {
    return { ok: false, reason: 'too_large' }
  }
  let stashCommit: string
  try {
    // Why: old Git needs a committer identity for the temporary stash commit; -c crosses WSL where env doesn't.
    stashCommit = (
      await io.git(
        ['-c', 'user.name=Orca', '-c', 'user.email=orca@localhost', 'stash', 'create'],
        sourcePath
      )
    ).trim()
  } catch (error) {
    // Why: e.g. an intent-to-add entry makes stash create refuse; nothing has been written yet.
    return { ok: false, reason: 'apply_failed', detail: errorMessage(error) }
  }
  // Why: the parent may commit after the HEAD check; applying a stash made on that new commit silently drops it.
  const stashBase = await io.git(
    stashCommit ? ['rev-parse', `${stashCommit}^1`] : ['rev-parse', 'HEAD'],
    sourcePath
  )
  if (stashBase.trim() !== targetHead.trim()) {
    return { ok: false, reason: 'base_mismatch' }
  }
  // Why: paths the stash adds land untracked in the target after `reset -q`; rollback must delete them explicitly.
  // Why: --no-renames keeps a renamed-to path classified as 'A' regardless of diff.renames config.
  const stashAddedPaths = stashCommit
    ? splitNulSeparated(
        await io.git(
          [
            'diff',
            '--name-only',
            '-z',
            '--no-renames',
            '--diff-filter=A',
            stashBase.trim(),
            stashCommit
          ],
          sourcePath
        )
      )
    : []
  // Why: a pre-existing (often ignored) target file at any path we're about to write would be silently clobbered.
  const candidatePaths = [...stashAddedPaths, ...untracked]
  const collisions = await Promise.all(
    candidatePaths.map((relativePath) => io.entryExists(targetPath, relativePath))
  )
  if (collisions.some(Boolean)) {
    return { ok: false, reason: 'target_dirty' }
  }
  const writtenPaths: string[] = []
  try {
    if (stashCommit) {
      writtenPaths.push(...stashAddedPaths)
      await io.git(['stash', 'apply', stashCommit], targetPath)
      // Why: staging cannot be reproduced faithfully across worktrees, so everything lands unstaged.
      await io.git(['reset', '-q'], targetPath)
    }
    for (const relativePath of untracked) {
      try {
        await io.copyEntry(sourcePath, targetPath, relativePath)
      } catch (error) {
        // Why: EEXIST means someone else's file is there; any other failure may leave our partial copy.
        if (!isAlreadyExistsError(error)) {
          writtenPaths.push(relativePath)
        }
        throw error
      }
      writtenPaths.push(relativePath)
    }
  } catch (error) {
    return await rollBackTarget(io, targetPath, writtenPaths, error)
  }
  return { ok: true, trackedChanges: stashCommit.length > 0, untrackedCopied: untracked.length }
}

const CARRY_FAILURE_REASONS: ReadonlySet<string> = new Set<WorkingTreeCarryFailureReason>([
  'base_mismatch',
  'target_dirty',
  'too_large',
  'apply_failed',
  'partially_applied'
])

function isCarryFailureReason(value: unknown): value is WorkingTreeCarryFailureReason {
  return typeof value === 'string' && CARRY_FAILURE_REASONS.has(value)
}

// Why: an SSH relay reply is untyped wire data; anything unrecognised surfaces as a failed carry.
export function normalizeWorkingTreeCarryResult(raw: unknown): WorkingTreeCarryResult {
  if (typeof raw === 'object' && raw !== null) {
    const record: Record<string, unknown> = { ...raw }
    if (record.ok === true) {
      return {
        ok: true,
        trackedChanges: record.trackedChanges === true,
        untrackedCopied: typeof record.untrackedCopied === 'number' ? record.untrackedCopied : 0
      }
    }
    if (record.ok === false && isCarryFailureReason(record.reason)) {
      return {
        ok: false,
        reason: record.reason,
        ...(typeof record.detail === 'string' ? { detail: record.detail } : {})
      }
    }
  }
  return { ok: false, reason: 'apply_failed', detail: 'Unexpected response from host' }
}
