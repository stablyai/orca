// Spotlight sync orchestration: the four public operations (activate / sync /
// deactivate / inspect). Low-level git primitives and guards live in
// ./spotlight-sync-primitives.
import { SPOTLIGHT_REFS } from './spotlight'
import {
  applySnapshotToRoot,
  assertNoConflictOperation,
  assertNoUntrackedCollisions,
  assertWorktreeBelongsToRoot,
  backupRootState,
  createCheckpointCommit,
  git,
  gitTry,
  inspectSpotlightRefsCore,
  readRootStatus,
  rollbackFreshActivation,
  SpotlightCoreError,
  type SpotlightGitContext,
  type SpotlightGitExecutor
} from './spotlight-sync-primitives'

export {
  SpotlightCoreError,
  createCheckpointCommit,
  inspectSpotlightRefsCore,
  type SpotlightGitContext,
  type SpotlightGitExecutor
}

export type SpotlightActivateOutcome = {
  snapshotSha: string
  /** Worktree HEAD the snapshot was built on — lets callers reuse the temp
   *  index on the next checkpoint when HEAD hasn't moved. */
  checkpointHeadSha: string
  originalBranch: string | null
  originalHeadSha: string
  backupSha: string
  /** True when spotlight refs already existed (takeover or re-activate): the
   *  pre-existing root backup was kept instead of re-captured. */
  alreadyActive: boolean
}

export type SpotlightSyncOutcome = {
  snapshotSha: string
  checkpointHeadSha: string
  /** True when the worktree tree matched the current snapshot — no reset ran. */
  skipped: boolean
}

export type SpotlightDeactivateOutcome = {
  /** The original branch could not be re-attached — it was deleted, or it got
   *  checked out in another worktree while Spotlight held the root detached. The
   *  root was still restored to the original commit, just left detached. */
  branchMissing: boolean
  /** The recorded original branch name (for logging), regardless of why it
   *  couldn't be re-attached. */
  originalBranch: string | null
  /** True only when the branch still EXISTS but the re-checkout failed (e.g.
   *  it's checked out in another worktree) — i.e. re-attach is recoverable by
   *  freeing it. False when the branch was deleted. */
  branchInUse: boolean
}

export async function activateSpotlightCore(
  ctx: SpotlightGitContext,
  rootPath: string,
  worktreePath: string,
  opts: { force?: boolean; reuseIndexForHead?: string | null } = {}
): Promise<SpotlightActivateOutcome> {
  await assertNoConflictOperation(ctx, rootPath)
  await assertNoConflictOperation(ctx, worktreePath)
  await assertWorktreeBelongsToRoot(ctx, rootPath, worktreePath)
  const isBare = await gitTry(ctx, rootPath, ['rev-parse', '--is-bare-repository'])
  if (isBare === 'true') {
    throw new SpotlightCoreError('bare-root', 'The repository root is a bare checkout.')
  }

  const refs = await inspectSpotlightRefsCore(ctx, rootPath)
  const alreadyActive = Boolean(refs.originalHeadSha && refs.backupSha)
  const rootStatus = await readRootStatus(ctx, rootPath)

  // Takeover/re-activate must honor the same divergence guards as sync — the
  // pre-existing backup does NOT contain commits or edits made in the root
  // after activation, so overwriting them here would be silent data loss.
  if (alreadyActive && !opts.force) {
    if (refs.rootHeadSha !== refs.snapshotSha) {
      throw new SpotlightCoreError(
        'root-diverged',
        'The repository root moved off the Spotlight snapshot (commit or checkout happened there).'
      )
    }
    if (rootStatus.trackedDirty) {
      throw new SpotlightCoreError(
        'root-diverged',
        'The repository root has tracked changes that were made outside the Spotlight workspace.'
      )
    }
  }

  // Checkpoint BEFORE any root mutation: a bad worktree (unborn HEAD, locked
  // index, transient git failure) must never leave the root detached.
  const checkpoint = await createCheckpointCommit(ctx, worktreePath, {
    reuseIndexForHead: opts.reuseIndexForHead
  })
  if (!opts.force) {
    await assertNoUntrackedCollisions(ctx, rootPath, checkpoint.sha, rootStatus.untrackedPaths)
  }

  if (alreadyActive) {
    await applySnapshotToRoot(ctx, rootPath, checkpoint.sha)
    return {
      snapshotSha: checkpoint.sha,
      checkpointHeadSha: checkpoint.headSha,
      originalBranch: refs.originalBranch,
      originalHeadSha: refs.originalHeadSha!,
      backupSha: refs.backupSha!,
      alreadyActive: true
    }
  }

  const original = await backupRootState(ctx, rootPath)
  try {
    await applySnapshotToRoot(ctx, rootPath, checkpoint.sha)
  } catch (error) {
    try {
      await rollbackFreshActivation(ctx, rootPath, original)
    } catch {
      // Restore also failed; rollbackFreshActivation intentionally keeps the
      // refs so the backup commit stays reachable. Surface the original
      // activation error, which explains why activation aborted.
    }
    throw error
  }
  return {
    snapshotSha: checkpoint.sha,
    checkpointHeadSha: checkpoint.headSha,
    ...original,
    alreadyActive: false
  }
}

export async function syncSpotlightCore(
  ctx: SpotlightGitContext,
  rootPath: string,
  worktreePath: string,
  opts: { force?: boolean; reuseIndexForHead?: string | null } = {}
): Promise<SpotlightSyncOutcome> {
  await assertNoConflictOperation(ctx, rootPath)
  await assertNoConflictOperation(ctx, worktreePath)
  const refs = await inspectSpotlightRefsCore(ctx, rootPath)
  if (!refs.snapshotSha || !refs.originalHeadSha) {
    throw new SpotlightCoreError('not-active', 'Spotlight is not active for this repository.')
  }

  const checkpoint = await createCheckpointCommit(ctx, worktreePath, {
    reuseIndexForHead: opts.reuseIndexForHead
  })
  const snapshotTree = await git(ctx, rootPath, ['rev-parse', `${refs.snapshotSha}^{tree}`])
  // Fast no-op path: the workspace tree already matches the root's snapshot and
  // the root hasn't moved. Return BEFORE the `status -uall` root scan so
  // watcher-debounced idle syncs don't enumerate the whole root working tree.
  if (checkpoint.treeSha === snapshotTree && refs.rootHeadSha === refs.snapshotSha && !opts.force) {
    return { snapshotSha: refs.snapshotSha, checkpointHeadSha: checkpoint.headSha, skipped: true }
  }

  // A reset will run — now pay for the guards that protect the root's own state.
  const rootStatus = opts.force ? null : await readRootStatus(ctx, rootPath)
  if (rootStatus) {
    if (refs.rootHeadSha !== refs.snapshotSha) {
      throw new SpotlightCoreError(
        'root-diverged',
        'The repository root moved off the Spotlight snapshot (commit or checkout happened there).'
      )
    }
    // Untracked root files are expected and preserved; only tracked edits made
    // directly in the root block the sync, because the reset would destroy them.
    if (rootStatus.trackedDirty) {
      throw new SpotlightCoreError(
        'root-diverged',
        'The repository root has tracked changes that were made outside the Spotlight workspace.'
      )
    }
    await assertNoUntrackedCollisions(ctx, rootPath, checkpoint.sha, rootStatus.untrackedPaths)
  }
  await applySnapshotToRoot(ctx, rootPath, checkpoint.sha)
  return { snapshotSha: checkpoint.sha, checkpointHeadSha: checkpoint.headSha, skipped: false }
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
  let branchInUse = false
  if (refs.originalBranch) {
    const branchSha = await gitTry(ctx, rootPath, [
      'rev-parse',
      '--verify',
      '-q',
      `refs/heads/${refs.originalBranch}`
    ])
    if (branchSha) {
      try {
        await git(ctx, rootPath, ['checkout', refs.originalBranch, '--'])
      } catch {
        // The branch still exists but can't be checked out here — most often it
        // was checked out in ANOTHER worktree while Spotlight had the root
        // detached (git refuses to check out a branch that's in use elsewhere).
        // Leave the root detached at originalHead so turn-off still completes
        // instead of getting wedged with the spotlight refs half-torn-down.
        branchMissing = true
        branchInUse = true
      }
    } else {
      // Branch was deleted while Spotlight was active.
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
  return { branchMissing, originalBranch: refs.originalBranch, branchInUse }
}
