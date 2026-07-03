// Git primitives and guards for the Spotlight sync engine. The transport-
// agnostic executor and low-level runners live in ./spotlight-git-exec.
import type { SpotlightRefsSnapshot } from './spotlight'
import { SPOTLIGHT_REFS } from './spotlight'
import {
  git,
  gitTry,
  IDENTITY_ARGS,
  resolveHead,
  SpotlightCoreError,
  stripHeadsPrefix,
  type SpotlightGitContext
} from './spotlight-git-exec'

export {
  SpotlightCoreError,
  git,
  gitTry,
  type SpotlightGitContext,
  type SpotlightGitExecutor
} from './spotlight-git-exec'

export async function assertNoConflictOperation(
  ctx: SpotlightGitContext,
  path: string
): Promise<void> {
  const operation = await ctx.detectConflict(path)
  if (operation !== 'unknown') {
    throw new SpotlightCoreError(
      'operation-in-progress',
      `A ${operation} is in progress in ${path}. Finish or abort it first.`
    )
  }
}

type RootStatus = {
  /** Tracked paths with staged or unstaged changes exist. */
  trackedDirty: boolean
  untrackedPaths: Set<string>
}

/** One `status --porcelain -z` read shared by the tracked-dirt guard and the
 *  untracked-collision guard. -z: NUL separators, no quoting of exotic paths. */
export async function readRootStatus(
  ctx: SpotlightGitContext,
  rootPath: string
): Promise<RootStatus> {
  // -uall: expand untracked directories to individual files. Without it git
  // collapses `sub/` to one entry, and a snapshot adding tracked `sub/file.txt`
  // would slip past the collision guard and get overwritten by reset --hard.
  const raw = await git(ctx, rootPath, ['status', '--porcelain', '-z', '-uall'])
  const tokens = raw.split('\0').filter((token) => token.length > 0)
  let trackedDirty = false
  const untrackedPaths = new Set<string>()
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index]
    const xy = entry.slice(0, 2)
    const entryPath = entry.slice(3)
    if (xy === '??') {
      untrackedPaths.add(entryPath)
      continue
    }
    trackedDirty = true
    // Rename/copy records carry the "from" path as the next NUL token.
    if (xy[0] === 'R' || xy[0] === 'C') {
      index += 1
    }
  }
  return { trackedDirty, untrackedPaths }
}

/** `reset --hard` overwrites untracked files whose paths become tracked in the
 *  snapshot — the one case where "untracked root files survive" is false. That
 *  content was never in any git object, so refuse instead of destroying it. */
export async function assertNoUntrackedCollisions(
  ctx: SpotlightGitContext,
  rootPath: string,
  snapshotSha: string,
  untrackedPaths: Set<string>
): Promise<void> {
  if (untrackedPaths.size === 0) {
    return
  }
  const raw = await git(ctx, rootPath, [
    'diff',
    '--name-only',
    '--diff-filter=A',
    '-z',
    'HEAD',
    snapshotSha
  ])
  const collisions = raw.split('\0').filter((p) => p.length > 0 && untrackedPaths.has(p))
  if (collisions.length > 0) {
    const shown = collisions.slice(0, 5).join(', ')
    const more = collisions.length > 5 ? ` (+${collisions.length - 5} more)` : ''
    throw new SpotlightCoreError(
      'untracked-collision',
      `Untracked files in the repository root would be overwritten by the workspace snapshot: ${shown}${more}. Move or delete them, or force the sync to overwrite.`
    )
  }
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
  worktreePath: string,
  opts: { reuseIndexForHead?: string | null } = {}
): Promise<{ sha: string; treeSha: string; headSha: string }> {
  const head = await resolveHead(ctx, worktreePath)
  // Relative output is fine: every command here runs with cwd = worktreePath,
  // and a relative GIT_INDEX_FILE resolves against the git process cwd.
  const indexPath = await git(ctx, worktreePath, [
    'rev-parse',
    '--git-path',
    'orca-spotlight-index'
  ])
  const env = { GIT_INDEX_FILE: indexPath }
  // Why the reuse path: `read-tree` wipes the temp index's stat cache, forcing
  // the following `add -A` to lstat + re-hash the entire worktree on every
  // watcher-debounced sync. When THIS worktree's index was already seeded from
  // this same HEAD, reuse it so `add -A` only re-stats changed files.
  //
  // Reuse requires a HEAD-seeded index: `add -A` against an empty/absent index
  // treats tracked-but-gitignored files (e.g. a force-added dist/config) as
  // ignored and drops them from the tree, which the root reset would then
  // DELETE. The caller must only pass reuseIndexForHead for a worktree whose
  // temp index it previously seeded (keyed per worktree, not per repo).
  if (opts.reuseIndexForHead !== head) {
    await git(ctx, worktreePath, ['read-tree', 'HEAD'], { env })
  }
  await git(ctx, worktreePath, ['add', '-A'], { env })
  const treeSha = await git(ctx, worktreePath, ['write-tree'], { env })
  const headTree = await git(ctx, worktreePath, ['rev-parse', `${head}^{tree}`])
  if (treeSha === headTree) {
    return { sha: head, treeSha, headSha: head }
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
  return { sha, treeSha, headSha: head }
}

export async function inspectSpotlightRefsCore(
  ctx: SpotlightGitContext,
  rootPath: string
): Promise<SpotlightRefsSnapshot> {
  // for-each-ref covers the three object refs in one spawn (vs three
  // rev-parse). originalBranch is read separately with symbolic-ref because
  // for-each-ref's handling of a dangling symref (branch deleted while active)
  // is unreliable — and losing it would break deactivate's re-attach.
  const [refsRaw, originalBranchRef, rootHeadSha] = await Promise.all([
    gitTry(ctx, rootPath, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
      SPOTLIGHT_REFS.snapshot,
      SPOTLIGHT_REFS.backup,
      SPOTLIGHT_REFS.originalHead
    ]),
    gitTry(ctx, rootPath, ['symbolic-ref', '-q', SPOTLIGHT_REFS.originalBranch]),
    gitTry(ctx, rootPath, ['rev-parse', '--verify', '-q', 'HEAD'])
  ])
  let snapshotSha: string | null = null
  let backupSha: string | null = null
  let originalHeadSha: string | null = null
  for (const line of (refsRaw ?? '').split('\n')) {
    const [refname, objectname] = line.split('\0')
    if (!refname || !objectname) {
      continue
    }
    if (refname === SPOTLIGHT_REFS.snapshot) {
      snapshotSha = objectname
    } else if (refname === SPOTLIGHT_REFS.backup) {
      backupSha = objectname
    } else if (refname === SPOTLIGHT_REFS.originalHead) {
      originalHeadSha = objectname
    }
  }
  return {
    snapshotSha,
    backupSha,
    originalHeadSha,
    originalBranch: originalBranchRef ? stripHeadsPrefix(originalBranchRef) : null,
    rootHeadSha
  }
}

export async function backupRootState(
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

/** Best-effort undo of a fresh activation's root mutations so a mid-flight
 *  failure never strands the root detached with orphan refs (which nothing in
 *  the app could see or repair — reconcile only visits persisted records). */
export async function rollbackFreshActivation(
  ctx: SpotlightGitContext,
  rootPath: string,
  originalBranch: string | null
): Promise<void> {
  if (originalBranch) {
    await gitTry(ctx, rootPath, ['checkout', originalBranch, '--'])
  }
  await gitTry(ctx, rootPath, ['update-ref', '-d', SPOTLIGHT_REFS.snapshot])
  await gitTry(ctx, rootPath, ['update-ref', '-d', SPOTLIGHT_REFS.backup])
  await gitTry(ctx, rootPath, ['update-ref', '-d', SPOTLIGHT_REFS.originalHead])
  await gitTry(ctx, rootPath, ['symbolic-ref', '--delete', SPOTLIGHT_REFS.originalBranch])
}

export async function applySnapshotToRoot(
  ctx: SpotlightGitContext,
  rootPath: string,
  snapshotSha: string
): Promise<void> {
  // Snapshot the ref's current value so we can roll it back if the reset fails.
  // Advancing the ref first protects the fresh checkpoint commit from gc during
  // the reset; but if the reset never lands, an advanced ref would sit ahead of
  // the (unmoved) root HEAD, and every later sync would then throw a spurious,
  // permanent 'root-diverged'. So on failure we restore the previous ref value.
  const previous = await gitTry(ctx, rootPath, [
    'rev-parse',
    '--verify',
    '-q',
    SPOTLIGHT_REFS.snapshot
  ])
  await git(ctx, rootPath, ['update-ref', SPOTLIGHT_REFS.snapshot, snapshotSha])
  // `reset --hard` mirrors adds/modifies/deletes/renames exactly and, aside
  // from the collision case guarded above, never touches untracked or ignored
  // files — root caches and installs survive.
  try {
    try {
      await git(ctx, rootPath, ['reset', '--hard', snapshotSha])
    } catch {
      // Dev servers/watchers holding file locks (Windows EBUSY) can fail a
      // reset transiently; the command is idempotent, so retry once.
      await git(ctx, rootPath, ['reset', '--hard', snapshotSha])
    }
  } catch (error) {
    await gitTry(
      ctx,
      rootPath,
      previous
        ? ['update-ref', SPOTLIGHT_REFS.snapshot, previous]
        : ['update-ref', '-d', SPOTLIGHT_REFS.snapshot]
    )
    throw error
  }
}

/** The holder must be a linked worktree of THIS repo (shared git common dir).
 *  Without this, a crafted `repoId::/arbitrary/path` id could make Spotlight
 *  checkpoint an unrelated directory or reset the root to a foreign tree. */
export async function assertWorktreeBelongsToRoot(
  ctx: SpotlightGitContext,
  rootPath: string,
  worktreePath: string
): Promise<void> {
  const [rootCommon, worktreeCommon] = await Promise.all([
    gitTry(ctx, rootPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    gitTry(ctx, worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ])
  if (!rootCommon || !worktreeCommon || rootCommon !== worktreeCommon) {
    throw new SpotlightCoreError(
      'worktree-not-found',
      'The selected workspace is not a worktree of this repository.'
    )
  }
}
