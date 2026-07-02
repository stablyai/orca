// Transport-agnostic Spotlight sync engine. All git access goes through the
// injected executor so the same logic can run locally, under WSL translation,
// or relay-side on an SSH host (phase 2). Commands are argv-only — no shell.
import type { GitConflictOperation } from './git-status-types'
import type { SpotlightErrorCode, SpotlightRefsSnapshot } from './spotlight'
import { SPOTLIGHT_REFS } from './spotlight'

export type SpotlightGitExecutor = (
  args: string[],
  cwd: string,
  opts?: { env?: Record<string, string> }
) => Promise<{ stdout: string; stderr?: string }>

export type SpotlightGitContext = {
  git: SpotlightGitExecutor
  detectConflict: (path: string) => Promise<GitConflictOperation>
}

export class SpotlightCoreError extends Error {
  readonly code: SpotlightErrorCode

  constructor(code: SpotlightErrorCode, message: string) {
    super(message)
    this.name = 'SpotlightCoreError'
    this.code = code
  }
}

export type SpotlightActivateOutcome = {
  snapshotSha: string
  originalBranch: string | null
  originalHeadSha: string
  backupSha: string
  /** True when spotlight refs already existed (takeover or re-activate): the
   *  pre-existing root backup was kept instead of re-captured. */
  alreadyActive: boolean
}

export type SpotlightSyncOutcome = {
  snapshotSha: string
  /** True when the worktree tree matched the current snapshot — no reset ran. */
  skipped: boolean
}

export type SpotlightDeactivateOutcome = {
  /** The original branch was deleted while Spotlight was active; the root was
   *  restored to the original commit but left detached. */
  branchMissing: boolean
}

// Why: checkpoint/backup commands create commit objects, and the repo may have
// no committer identity configured — inline one so they never fail on that.
const IDENTITY_ARGS = [
  '-c',
  'user.name=Orca Spotlight',
  '-c',
  'user.email=spotlight@orca.local'
] as const

function stderrOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const maybe = error as { stderr?: unknown; message?: unknown }
    if (typeof maybe.stderr === 'string' && maybe.stderr.trim()) {
      return maybe.stderr.trim()
    }
    if (typeof maybe.message === 'string') {
      return maybe.message
    }
  }
  return String(error)
}

async function git(
  ctx: SpotlightGitContext,
  cwd: string,
  args: string[],
  opts?: { env?: Record<string, string> }
): Promise<string> {
  try {
    const { stdout } = await ctx.git(args, cwd, opts)
    return stdout.trim()
  } catch (error) {
    throw new SpotlightCoreError('git-failed', `git ${args[0]} failed: ${stderrOf(error)}`)
  }
}

/** Like `git`, but a non-zero exit means "absent" rather than failure. */
async function gitTry(
  ctx: SpotlightGitContext,
  cwd: string,
  args: string[]
): Promise<string | null> {
  try {
    const { stdout } = await ctx.git(args, cwd)
    const value = stdout.trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

async function assertNoConflictOperation(ctx: SpotlightGitContext, path: string): Promise<void> {
  const operation = await ctx.detectConflict(path)
  if (operation !== 'unknown') {
    throw new SpotlightCoreError(
      'operation-in-progress',
      `A ${operation} is in progress in ${path}. Finish or abort it first.`
    )
  }
}

async function resolveHead(ctx: SpotlightGitContext, path: string): Promise<string> {
  const head = await gitTry(ctx, path, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (!head) {
    throw new SpotlightCoreError('unborn-head', `${path} has no commits yet.`)
  }
  return head
}

function stripHeadsPrefix(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

/**
 * Commit the worktree's current file state (tracked changes plus untracked,
 * non-ignored files) without touching its HEAD, real index, or working tree.
 *
 * Why a temporary index instead of `git stash create`: stash omits untracked
 * files, but agents routinely create new source files without staging them —
 * those must reach the root too. `.gitignore` still excludes build artifacts.
 */
export async function createCheckpointCommit(
  ctx: SpotlightGitContext,
  worktreePath: string
): Promise<{ sha: string; treeSha: string }> {
  const head = await resolveHead(ctx, worktreePath)
  // Relative output is fine: every command here runs with cwd = worktreePath,
  // and a relative GIT_INDEX_FILE resolves against the git process cwd.
  const indexPath = await git(ctx, worktreePath, [
    'rev-parse',
    '--git-path',
    'orca-spotlight-index'
  ])
  const env = { GIT_INDEX_FILE: indexPath }
  await git(ctx, worktreePath, ['read-tree', 'HEAD'], { env })
  await git(ctx, worktreePath, ['add', '-A'], { env })
  const treeSha = await git(ctx, worktreePath, ['write-tree'], { env })
  const headTree = await git(ctx, worktreePath, ['rev-parse', `${head}^{tree}`])
  if (treeSha === headTree) {
    return { sha: head, treeSha }
  }
  const sha = await git(ctx, worktreePath, [
    ...IDENTITY_ARGS,
    'commit-tree',
    treeSha,
    '-p',
    head,
    '-m',
    'Orca Spotlight snapshot'
  ])
  return { sha, treeSha }
}

export async function inspectSpotlightRefsCore(
  ctx: SpotlightGitContext,
  rootPath: string
): Promise<SpotlightRefsSnapshot> {
  const [snapshotSha, backupSha, originalHeadSha, originalBranchRef, rootHeadSha] =
    await Promise.all([
      gitTry(ctx, rootPath, ['rev-parse', '--verify', '-q', SPOTLIGHT_REFS.snapshot]),
      gitTry(ctx, rootPath, ['rev-parse', '--verify', '-q', SPOTLIGHT_REFS.backup]),
      gitTry(ctx, rootPath, ['rev-parse', '--verify', '-q', SPOTLIGHT_REFS.originalHead]),
      gitTry(ctx, rootPath, ['symbolic-ref', '-q', SPOTLIGHT_REFS.originalBranch]),
      gitTry(ctx, rootPath, ['rev-parse', '--verify', '-q', 'HEAD'])
    ])
  return {
    snapshotSha,
    backupSha,
    originalHeadSha,
    originalBranch: originalBranchRef ? stripHeadsPrefix(originalBranchRef) : null,
    rootHeadSha
  }
}

async function backupRootState(
  ctx: SpotlightGitContext,
  rootPath: string
): Promise<{ originalBranch: string | null; originalHeadSha: string; backupSha: string }> {
  const originalHeadSha = await resolveHead(ctx, rootPath)
  const originalBranchRef = await gitTry(ctx, rootPath, ['symbolic-ref', '-q', 'HEAD'])
  // `stash create` captures tracked working-tree changes AND index state
  // (parent #2) without moving refs/stash; empty output means the root is
  // clean, so the head commit itself is the backup.
  const stashSha = await git(ctx, rootPath, [...IDENTITY_ARGS, 'stash', 'create'])
  const backupSha = stashSha || originalHeadSha
  // Why refs are written before any destructive command: a crash after this
  // point leaves everything recoverable with plain git.
  await git(ctx, rootPath, ['update-ref', SPOTLIGHT_REFS.backup, backupSha])
  await git(ctx, rootPath, ['update-ref', SPOTLIGHT_REFS.originalHead, originalHeadSha])
  if (originalBranchRef) {
    await git(ctx, rootPath, ['symbolic-ref', SPOTLIGHT_REFS.originalBranch, originalBranchRef])
  }
  // Detach so the snapshot resets never move the original branch pointer.
  await git(ctx, rootPath, ['checkout', '--detach'])
  return {
    originalBranch: originalBranchRef ? stripHeadsPrefix(originalBranchRef) : null,
    originalHeadSha,
    backupSha
  }
}

async function applySnapshotToRoot(
  ctx: SpotlightGitContext,
  rootPath: string,
  snapshotSha: string
): Promise<void> {
  await git(ctx, rootPath, ['update-ref', SPOTLIGHT_REFS.snapshot, snapshotSha])
  // `reset --hard` mirrors adds/modifies/deletes/renames exactly and never
  // touches untracked or ignored files — root caches and installs survive.
  try {
    await git(ctx, rootPath, ['reset', '--hard', snapshotSha])
  } catch {
    // Why: dev servers/watchers holding file locks (Windows EBUSY) can fail a
    // reset transiently; the command is idempotent, so retry once.
    await git(ctx, rootPath, ['reset', '--hard', snapshotSha])
  }
}

export async function activateSpotlightCore(
  ctx: SpotlightGitContext,
  rootPath: string,
  worktreePath: string
): Promise<SpotlightActivateOutcome> {
  await assertNoConflictOperation(ctx, rootPath)
  await assertNoConflictOperation(ctx, worktreePath)
  const isBare = await gitTry(ctx, rootPath, ['rev-parse', '--is-bare-repository'])
  if (isBare === 'true') {
    throw new SpotlightCoreError('bare-root', 'The repository root is a bare checkout.')
  }

  const refs = await inspectSpotlightRefsCore(ctx, rootPath)
  // Takeover / re-activate: when the root is already in Spotlight mode, keep
  // the pre-existing backup — re-capturing would save snapshot state as
  // "original" and lose the user's real root state.
  const original =
    refs.originalHeadSha && refs.backupSha
      ? {
          originalBranch: refs.originalBranch,
          originalHeadSha: refs.originalHeadSha,
          backupSha: refs.backupSha
        }
      : await backupRootState(ctx, rootPath)

  const checkpoint = await createCheckpointCommit(ctx, worktreePath)
  await applySnapshotToRoot(ctx, rootPath, checkpoint.sha)
  return {
    snapshotSha: checkpoint.sha,
    ...original,
    alreadyActive: Boolean(refs.originalHeadSha && refs.backupSha)
  }
}

export async function syncSpotlightCore(
  ctx: SpotlightGitContext,
  rootPath: string,
  worktreePath: string,
  opts: { force?: boolean } = {}
): Promise<SpotlightSyncOutcome> {
  await assertNoConflictOperation(ctx, rootPath)
  await assertNoConflictOperation(ctx, worktreePath)
  const refs = await inspectSpotlightRefsCore(ctx, rootPath)
  if (!refs.snapshotSha || !refs.originalHeadSha) {
    throw new SpotlightCoreError('not-active', 'Spotlight is not active for this repository.')
  }
  if (!opts.force) {
    if (refs.rootHeadSha !== refs.snapshotSha) {
      throw new SpotlightCoreError(
        'root-diverged',
        'The repository root moved off the Spotlight snapshot (commit or checkout happened there).'
      )
    }
    // -uno: untracked files in the root are expected and preserved; only
    // tracked edits made directly in the root block the sync, because the
    // reset would silently destroy them.
    const dirty = await git(ctx, rootPath, ['status', '--porcelain', '-uno'])
    if (dirty.length > 0) {
      throw new SpotlightCoreError(
        'root-diverged',
        'The repository root has tracked changes that were made outside the Spotlight workspace.'
      )
    }
  }

  const checkpoint = await createCheckpointCommit(ctx, worktreePath)
  const snapshotTree = await git(ctx, rootPath, ['rev-parse', `${refs.snapshotSha}^{tree}`])
  if (checkpoint.treeSha === snapshotTree && refs.rootHeadSha === refs.snapshotSha && !opts.force) {
    return { snapshotSha: refs.snapshotSha, skipped: true }
  }
  await applySnapshotToRoot(ctx, rootPath, checkpoint.sha)
  return { snapshotSha: checkpoint.sha, skipped: false }
}

export async function deactivateSpotlightCore(
  ctx: SpotlightGitContext,
  rootPath: string,
  opts: { discardBackup?: boolean } = {}
): Promise<SpotlightDeactivateOutcome> {
  await assertNoConflictOperation(ctx, rootPath)
  const refs = await inspectSpotlightRefsCore(ctx, rootPath)
  if (!refs.originalHeadSha) {
    throw new SpotlightCoreError('not-active', 'Spotlight is not active for this repository.')
  }

  await git(ctx, rootPath, ['reset', '--hard', refs.originalHeadSha])

  let branchMissing = false
  if (refs.originalBranch) {
    const branchSha = await gitTry(ctx, rootPath, [
      'rev-parse',
      '--verify',
      '-q',
      `refs/heads/${refs.originalBranch}`
    ])
    if (branchSha) {
      await git(ctx, rootPath, ['checkout', refs.originalBranch, '--'])
    } else {
      branchMissing = true
    }
  }

  if (refs.backupSha && refs.backupSha !== refs.originalHeadSha && !opts.discardBackup) {
    try {
      // --index also restores what was staged vs unstaged at activation time.
      await git(ctx, rootPath, ['stash', 'apply', '--index', refs.backupSha])
    } catch (error) {
      // Keep the refs: the backup stays reachable and the user can retry or
      // apply it manually (`git stash apply --index refs/orca/spotlight/backup`).
      throw new SpotlightCoreError(
        'restore-conflict',
        `Restoring the root's original uncommitted changes conflicted: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  await git(ctx, rootPath, ['update-ref', '-d', SPOTLIGHT_REFS.snapshot])
  await git(ctx, rootPath, ['update-ref', '-d', SPOTLIGHT_REFS.backup])
  await git(ctx, rootPath, ['update-ref', '-d', SPOTLIGHT_REFS.originalHead])
  if (refs.originalBranch) {
    await gitTry(ctx, rootPath, ['symbolic-ref', '--delete', SPOTLIGHT_REFS.originalBranch])
  }
  return { branchMissing }
}
