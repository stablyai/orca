import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  activateSpotlightCore,
  createCheckpointCommit,
  deactivateSpotlightCore,
  inspectSpotlightRefsCore,
  purgeSpotlightRefsCore,
  syncSpotlightCore,
  SpotlightCoreError,
  type SpotlightGitContext,
  type SpotlightGitExecutor
} from './spotlight-sync-core'

const execFileAsync = promisify(execFile)

const realGitExecutor: SpotlightGitExecutor = async (args, cwd, opts) => {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: opts?.env ? { ...process.env, ...opts.env } : process.env
  })
  return { stdout, stderr }
}

function makeContext(overrides: Partial<SpotlightGitContext> = {}): SpotlightGitContext {
  return {
    git: realGitExecutor,
    detectConflict: async () => 'unknown',
    ...overrides
  }
}

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim()
}

function write(dir: string, relPath: string, content: string): void {
  const filePath = path.join(dir, relPath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
}

describe('spotlight-sync-core', () => {
  let baseDir: string
  let rootPath: string
  let worktreePath: string
  const ctx = makeContext()

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'orca-spotlight-'))
    rootPath = path.join(baseDir, 'root')
    worktreePath = path.join(baseDir, 'wt')
    mkdirSync(rootPath)
    run(rootPath, 'init', '-b', 'main')
    run(rootPath, 'config', 'user.name', 'Test')
    run(rootPath, 'config', 'user.email', 'test@example.com')
    write(rootPath, '.gitignore', 'node_modules/\n')
    write(rootPath, 'a.txt', 'a-original\n')
    write(rootPath, 'dir/b.txt', 'b-original\n')
    write(rootPath, 'to-delete.txt', 'delete-me\n')
    run(rootPath, 'add', '-A')
    run(rootPath, 'commit', '-m', 'initial')
    run(rootPath, 'worktree', 'add', worktreePath, '-b', 'feature')
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('activate mirrors adds, edits, deletes and untracked files onto the root', async () => {
    write(worktreePath, 'a.txt', 'a-changed\n')
    write(worktreePath, 'brand-new.txt', 'new-file\n') // untracked, never staged
    rmSync(path.join(worktreePath, 'to-delete.txt'))
    write(worktreePath, 'node_modules/dep.js', 'ignored\n') // gitignored
    write(rootPath, 'node_modules/root-dep.js', 'root-install\n')
    write(rootPath, 'stray.log', 'untracked-root-file\n')

    const outcome = await activateSpotlightCore(ctx, rootPath, worktreePath)

    expect(readFileSync(path.join(rootPath, 'a.txt'), 'utf-8')).toBe('a-changed\n')
    expect(readFileSync(path.join(rootPath, 'brand-new.txt'), 'utf-8')).toBe('new-file\n')
    expect(existsSync(path.join(rootPath, 'to-delete.txt'))).toBe(false)
    // Ignored files never sync; untracked files already in the root survive.
    expect(existsSync(path.join(rootPath, 'node_modules/dep.js'))).toBe(false)
    expect(readFileSync(path.join(rootPath, 'node_modules/root-dep.js'), 'utf-8')).toBe(
      'root-install\n'
    )
    expect(readFileSync(path.join(rootPath, 'stray.log'), 'utf-8')).toBe('untracked-root-file\n')
    // Root is detached at the snapshot; the original branch pointer is safe.
    expect(run(rootPath, 'rev-parse', 'HEAD')).toBe(outcome.snapshotSha)
    expect(() => run(rootPath, 'symbolic-ref', '-q', 'HEAD')).toThrow()
    expect(outcome.alreadyActive).toBe(false)
    expect(outcome.originalBranch).toBe('main')
  })

  it('never disturbs the worktree branch, index, or files', async () => {
    write(worktreePath, 'a.txt', 'a-changed\n')
    write(worktreePath, 'staged.txt', 'staged\n')
    run(worktreePath, 'add', 'staged.txt')
    write(worktreePath, 'unstaged-new.txt', 'unstaged\n')
    const statusBefore = run(worktreePath, 'status', '--porcelain')
    const headBefore = run(worktreePath, 'rev-parse', 'HEAD')

    await activateSpotlightCore(ctx, rootPath, worktreePath)

    expect(run(worktreePath, 'status', '--porcelain')).toBe(statusBefore)
    expect(run(worktreePath, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(run(worktreePath, 'symbolic-ref', '--short', 'HEAD')).toBe('feature')
  })

  it('sync applies incremental changes and skips no-op syncs', async () => {
    write(worktreePath, 'a.txt', 'v1\n')
    await activateSpotlightCore(ctx, rootPath, worktreePath)

    write(worktreePath, 'a.txt', 'v2\n')
    write(worktreePath, 'dir/c.txt', 'c-new\n')
    const synced = await syncSpotlightCore(ctx, rootPath, worktreePath)
    expect(synced.skipped).toBe(false)
    expect(readFileSync(path.join(rootPath, 'a.txt'), 'utf-8')).toBe('v2\n')
    expect(readFileSync(path.join(rootPath, 'dir/c.txt'), 'utf-8')).toBe('c-new\n')

    const noop = await syncSpotlightCore(ctx, rootPath, worktreePath)
    expect(noop.skipped).toBe(true)
    expect(noop.snapshotSha).toBe(synced.snapshotSha)
  })

  it('restores a dirty root exactly on deactivate, including staged state', async () => {
    write(rootPath, 'a.txt', 'root-edit\n')
    write(rootPath, 'root-staged.txt', 'root-staged\n')
    run(rootPath, 'add', 'root-staged.txt')
    const statusBefore = run(rootPath, 'status', '--porcelain')
    const stagedBefore = run(rootPath, 'diff', '--cached', '--name-only')

    write(worktreePath, 'a.txt', 'wt-version\n')
    await activateSpotlightCore(ctx, rootPath, worktreePath)
    expect(readFileSync(path.join(rootPath, 'a.txt'), 'utf-8')).toBe('wt-version\n')

    await deactivateSpotlightCore(ctx, rootPath)

    expect(run(rootPath, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(run(rootPath, 'status', '--porcelain')).toBe(statusBefore)
    expect(run(rootPath, 'diff', '--cached', '--name-only')).toBe(stagedBefore)
    expect(readFileSync(path.join(rootPath, 'a.txt'), 'utf-8')).toBe('root-edit\n')
    // All spotlight refs are gone.
    const refs = await inspectSpotlightRefsCore(ctx, rootPath)
    expect(refs.snapshotSha).toBeNull()
    expect(refs.backupSha).toBeNull()
    expect(refs.originalHeadSha).toBeNull()
  })

  it('refuses to sync when the root diverged, unless forced', async () => {
    await activateSpotlightCore(ctx, rootPath, worktreePath)
    write(rootPath, 'a.txt', 'edited-directly-in-root\n')

    write(worktreePath, 'a.txt', 'wt-change\n')
    await expect(syncSpotlightCore(ctx, rootPath, worktreePath)).rejects.toMatchObject({
      code: 'root-diverged'
    })

    const forced = await syncSpotlightCore(ctx, rootPath, worktreePath, { force: true })
    expect(forced.skipped).toBe(false)
    expect(readFileSync(path.join(rootPath, 'a.txt'), 'utf-8')).toBe('wt-change\n')
  })

  it('takeover keeps the original root backup', async () => {
    const worktree2 = path.join(baseDir, 'wt2')
    run(rootPath, 'worktree', 'add', worktree2, '-b', 'feature-2')
    write(rootPath, 'a.txt', 'root-uncommitted\n')

    write(worktreePath, 'a.txt', 'wt1-version\n')
    await activateSpotlightCore(ctx, rootPath, worktreePath)

    write(worktree2, 'a.txt', 'wt2-version\n')
    const takeover = await activateSpotlightCore(ctx, rootPath, worktree2)
    expect(takeover.alreadyActive).toBe(true)
    expect(readFileSync(path.join(rootPath, 'a.txt'), 'utf-8')).toBe('wt2-version\n')

    await deactivateSpotlightCore(ctx, rootPath)
    expect(readFileSync(path.join(rootPath, 'a.txt'), 'utf-8')).toBe('root-uncommitted\n')
    expect(run(rootPath, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  })

  it('deactivate with a deleted original branch stays detached and reports it', async () => {
    await activateSpotlightCore(ctx, rootPath, worktreePath)
    const originalHead = (await inspectSpotlightRefsCore(ctx, rootPath)).originalHeadSha
    run(rootPath, 'branch', '-D', 'main')

    const outcome = await deactivateSpotlightCore(ctx, rootPath)
    expect(outcome.branchMissing).toBe(true)
    // Deleted, not in use — so the renderer shows "no longer exists", not "in use".
    expect(outcome.branchInUse).toBe(false)
    expect(run(rootPath, 'rev-parse', 'HEAD')).toBe(originalHead)
    expect(() => run(rootPath, 'symbolic-ref', '-q', 'HEAD')).toThrow()
  })

  it('deactivate stays detached when the original branch is checked out elsewhere', async () => {
    // Root on 'main'. Activate detaches it, which frees 'main' for another
    // worktree to grab — then deactivate can't re-checkout 'main' in the root.
    await activateSpotlightCore(ctx, rootPath, worktreePath)
    const originalHead = (await inspectSpotlightRefsCore(ctx, rootPath)).originalHeadSha
    const other = path.join(baseDir, 'other')
    run(rootPath, 'worktree', 'add', other, 'main')

    // Must NOT throw (the old code hard-failed on `checkout main` → wedged).
    const outcome = await deactivateSpotlightCore(ctx, rootPath)
    expect(outcome.branchMissing).toBe(true)
    // Branch still exists (in use elsewhere) — recoverable by freeing it.
    expect(outcome.branchInUse).toBe(true)
    // Root restored to its original commit, left detached, spotlight refs gone.
    expect(run(rootPath, 'rev-parse', 'HEAD')).toBe(originalHead)
    expect(() => run(rootPath, 'symbolic-ref', '-q', 'HEAD')).toThrow()
    expect((await inspectSpotlightRefsCore(ctx, rootPath)).originalHeadSha).toBeNull()
  })

  it('purge removes the anchor refs but keeps the backup for recovery', async () => {
    // Dirty the root so the backup ref is a distinct stash commit, not originalHead.
    write(rootPath, 'a.txt', 'a-dirty-in-root\n')
    await activateSpotlightCore(ctx, rootPath, worktreePath)
    const before = await inspectSpotlightRefsCore(ctx, rootPath)
    expect(before.snapshotSha).not.toBeNull()
    expect(before.originalHeadSha).not.toBeNull()
    expect(before.backupSha).not.toBeNull()

    await purgeSpotlightRefsCore(ctx, rootPath)

    const after = await inspectSpotlightRefsCore(ctx, rootPath)
    expect(after.snapshotSha).toBeNull()
    expect(after.originalHeadSha).toBeNull()
    expect(after.originalBranch).toBeNull()
    // Backup preserved: the root's uncommitted state stays recoverable.
    expect(after.backupSha).toBe(before.backupSha)
  })

  it('handles renames', async () => {
    run(worktreePath, 'mv', 'a.txt', 'renamed.txt')
    await activateSpotlightCore(ctx, rootPath, worktreePath)
    expect(existsSync(path.join(rootPath, 'a.txt'))).toBe(false)
    expect(readFileSync(path.join(rootPath, 'renamed.txt'), 'utf-8')).toBe('a-original\n')
  })

  it('refuses to run during a merge/rebase', async () => {
    const conflictedCtx = makeContext({ detectConflict: async () => 'rebase' })
    await expect(activateSpotlightCore(conflictedCtx, rootPath, worktreePath)).rejects.toThrow(
      SpotlightCoreError
    )
    await expect(
      activateSpotlightCore(conflictedCtx, rootPath, worktreePath)
    ).rejects.toMatchObject({ code: 'operation-in-progress' })
  })

  it('sync without activation reports not-active', async () => {
    await expect(syncSpotlightCore(ctx, rootPath, worktreePath)).rejects.toMatchObject({
      code: 'not-active'
    })
    await expect(deactivateSpotlightCore(ctx, rootPath)).rejects.toMatchObject({
      code: 'not-active'
    })
  })

  it('checkpoint of a clean worktree reuses HEAD', async () => {
    const head = run(worktreePath, 'rev-parse', 'HEAD')
    const checkpoint = await createCheckpointCommit(ctx, worktreePath)
    expect(checkpoint.sha).toBe(head)
    expect(checkpoint.headSha).toBe(head)
  })

  it('takeover refuses when the root diverged, and force overwrites', async () => {
    const worktree2 = path.join(baseDir, 'wt2')
    run(rootPath, 'worktree', 'add', worktree2, '-b', 'feature-2')
    await activateSpotlightCore(ctx, rootPath, worktreePath)

    // A tracked edit made directly in the root while Spotlight is active.
    write(rootPath, 'a.txt', 'edited-directly-in-root\n')
    write(worktree2, 'a.txt', 'wt2-version\n')
    await expect(activateSpotlightCore(ctx, rootPath, worktree2)).rejects.toMatchObject({
      code: 'root-diverged'
    })
    // The root edit survived the refusal.
    expect(readFileSync(path.join(rootPath, 'a.txt'), 'utf-8')).toBe('edited-directly-in-root\n')

    const forced = await activateSpotlightCore(ctx, rootPath, worktree2, { force: true })
    expect(forced.alreadyActive).toBe(true)
    expect(readFileSync(path.join(rootPath, 'a.txt'), 'utf-8')).toBe('wt2-version\n')
  })

  it('refuses to overwrite an untracked root file that collides with a new tracked path', async () => {
    // Untracked scratch file in the root the user expects to keep.
    write(rootPath, 'scratch.txt', 'precious-untracked\n')
    // The workspace tracks a file at the same path.
    write(worktreePath, 'scratch.txt', 'workspace-version\n')
    run(worktreePath, 'add', 'scratch.txt')

    await expect(activateSpotlightCore(ctx, rootPath, worktreePath)).rejects.toMatchObject({
      code: 'untracked-collision'
    })
    // Refusal left the untracked file and the root's branch untouched.
    expect(readFileSync(path.join(rootPath, 'scratch.txt'), 'utf-8')).toBe('precious-untracked\n')
    expect(run(rootPath, 'symbolic-ref', '--short', 'HEAD')).toBe('main')

    const forced = await activateSpotlightCore(ctx, rootPath, worktreePath, { force: true })
    expect(forced.alreadyActive).toBe(false)
    expect(readFileSync(path.join(rootPath, 'scratch.txt'), 'utf-8')).toBe('workspace-version\n')
  })

  it('does not mutate the root when the worktree checkpoint fails (unborn HEAD)', async () => {
    // A fresh worktree on an orphan branch has no commit — checkpoint throws.
    const orphan = path.join(baseDir, 'orphan')
    mkdirSync(orphan)
    run(rootPath, 'worktree', 'add', '--detach', orphan)
    run(orphan, 'checkout', '--orphan', 'orphan-branch')
    run(orphan, 'rm', '-rf', '.')

    await expect(activateSpotlightCore(ctx, rootPath, orphan)).rejects.toMatchObject({
      code: 'unborn-head'
    })
    // Root untouched: still on its branch, no spotlight refs written.
    expect(run(rootPath, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    const refs = await inspectSpotlightRefsCore(ctx, rootPath)
    expect(refs.originalHeadSha).toBeNull()
    expect(refs.snapshotSha).toBeNull()
  })

  it('keeps the backup ref when a fresh activation cannot restore the root', async () => {
    // Uncommitted tracked change in the root — backupRootState captures it in a
    // stash-create commit (no reflog), so the backup ref is its only reference.
    write(rootPath, 'a.txt', 'root-dirty\n')
    write(worktreePath, 'a.txt', 'a-changed\n')
    // Every `reset --hard` fails (e.g. a locked file / EBUSY): the fresh
    // activation's apply fails AND the rollback's restore fails.
    const failingResets = makeContext({
      git: async (args, cwd, opts) => {
        if (args[0] === 'reset' && args[1] === '--hard') {
          throw new Error('simulated reset failure')
        }
        return realGitExecutor(args, cwd, opts)
      }
    })
    await expect(
      activateSpotlightCore(failingResets, rootPath, worktreePath)
    ).rejects.toBeInstanceOf(SpotlightCoreError)
    // The refs (backup especially) must survive so the user's uncommitted root
    // state stays reachable instead of becoming a dangling, fsck-only commit.
    const refs = await inspectSpotlightRefsCore(ctx, rootPath)
    expect(refs.backupSha).not.toBeNull()
    expect(refs.backupSha).not.toBe(refs.originalHeadSha)
    expect(refs.originalHeadSha).not.toBeNull()
    // That backup commit still holds the root's uncommitted edit.
    expect(run(rootPath, 'show', `${refs.backupSha}:a.txt`)).toBe('root-dirty')
  })

  it('blocks a fresh activation when the root is detached', async () => {
    write(worktreePath, 'a.txt', 'a-changed\n')
    run(rootPath, 'checkout', '--detach')
    await expect(
      activateSpotlightCore(ctx, rootPath, worktreePath, { requireOnBranch: true })
    ).rejects.toMatchObject({ code: 'not-on-primary-branch' })
    // Root untouched — no spotlight refs written.
    expect((await inspectSpotlightRefsCore(ctx, rootPath)).snapshotSha).toBeNull()
  })

  it('allows a fresh activation when the root is on any branch (e.g. develop, not master)', async () => {
    run(rootPath, 'checkout', '-b', 'develop')
    write(worktreePath, 'a.txt', 'a-changed\n')
    const outcome = await activateSpotlightCore(ctx, rootPath, worktreePath, {
      requireOnBranch: true
    })
    expect(outcome.alreadyActive).toBe(false)
  })

  it('does not require a branch on takeover (root is detached-by-Spotlight)', async () => {
    await activateSpotlightCore(ctx, rootPath, worktreePath, { requireOnBranch: true })
    write(worktreePath, 'a.txt', 'again\n')
    // Second activation is a takeover (refs exist); the root is legitimately
    // detached-by-Spotlight, so requireOnBranch must not block it.
    const outcome = await activateSpotlightCore(ctx, rootPath, worktreePath, {
      requireOnBranch: true
    })
    expect(outcome.alreadyActive).toBe(true)
  })

  it('recovers instead of wedging when a prior deactivate left orphan refs', async () => {
    write(worktreePath, 'a.txt', 'a-changed\n')
    await activateSpotlightCore(ctx, rootPath, worktreePath)
    // Simulate a deactivate interrupted after it restored the root but before it
    // finished deleting refs (snapshot is deleted first) — leaving orphaned
    // backup + originalHead refs with no snapshot.
    const originalHead = (await inspectSpotlightRefsCore(ctx, rootPath)).originalHeadSha as string
    run(rootPath, 'reset', '--hard', originalHead)
    run(rootPath, 'checkout', 'main', '--')
    run(rootPath, 'update-ref', '-d', 'refs/orca/spotlight/snapshot')

    // Old code keyed alreadyActive on backup+originalHead only, so this threw a
    // permanent root-diverged. It must instead re-activate cleanly.
    const outcome = await activateSpotlightCore(ctx, rootPath, worktreePath)
    expect(outcome.alreadyActive).toBe(false)
    expect(readFileSync(path.join(rootPath, 'a.txt'), 'utf-8')).toBe('a-changed\n')
  })

  it('rejects a worktree that does not belong to the repo', async () => {
    const otherBase = mkdtempSync(path.join(tmpdir(), 'orca-spotlight-other-'))
    try {
      run(otherBase, 'init', '-b', 'main')
      run(otherBase, 'config', 'user.name', 'Test')
      run(otherBase, 'config', 'user.email', 'test@example.com')
      write(otherBase, 'x.txt', 'x\n')
      run(otherBase, 'add', '-A')
      run(otherBase, 'commit', '-m', 'other')
      await expect(activateSpotlightCore(ctx, rootPath, otherBase)).rejects.toMatchObject({
        code: 'worktree-not-found'
      })
      expect(run(rootPath, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    } finally {
      rmSync(otherBase, { recursive: true, force: true })
    }
  })

  it('reuses the temp index across syncs without corrupting the tree', async () => {
    write(worktreePath, 'a.txt', 'v1\n')
    const activated = await activateSpotlightCore(ctx, rootPath, worktreePath)

    write(worktreePath, 'a.txt', 'v2\n')
    write(worktreePath, 'new.txt', 'brand-new\n')
    const synced = await syncSpotlightCore(ctx, rootPath, worktreePath, {
      reuseIndexForHead: activated.checkpointHeadSha
    })
    expect(synced.skipped).toBe(false)
    expect(readFileSync(path.join(rootPath, 'a.txt'), 'utf-8')).toBe('v2\n')
    expect(readFileSync(path.join(rootPath, 'new.txt'), 'utf-8')).toBe('brand-new\n')
  })
})
