import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CARRY_MAX_UNTRACKED_FILES,
  CARRY_SYMLINKED_ANCESTOR_CODE,
  carryWorkingTreeChanges,
  normalizeWorkingTreeCarryResult,
  type WorkingTreeCarryIo
} from './working-tree-change-carry'
import {
  copyNodeWorkingTreeEntry,
  findNodeSymlinkedAncestor,
  nodeWorkingTreeEntryExists,
  removeNodeWorkingTreeEntry,
  sumNodeEntrySizes
} from './working-tree-change-carry-node-fs'

const tempPaths: string[] = []
afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

const io: WorkingTreeCarryIo = {
  git: async (args, cwd) => git(cwd, ...args),
  sumEntrySizes: sumNodeEntrySizes,
  copyEntry: copyNodeWorkingTreeEntry,
  removeEntry: removeNodeWorkingTreeEntry,
  entryExists: nodeWorkingTreeEntryExists,
  findSymlinkedAncestor: findNodeSymlinkedAncestor
}

function createRepoWithChild(extraFiles: Record<string, string> = {}): {
  source: string
  target: string
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-carry-'))
  tempPaths.push(root)
  const source = join(root, 'source')
  mkdirSync(source)
  git(source, 'init', '--quiet')
  git(source, 'config', 'user.name', 'Orca Test')
  git(source, 'config', 'user.email', 'orca@example.test')
  git(source, 'config', 'commit.gpgSign', 'false')
  git(source, 'config', 'core.hooksPath', '.git/no-hooks')
  writeFileSync(join(source, 'tracked.txt'), 'base\n')
  writeFileSync(join(source, 'staged.txt'), 'base\n')
  writeFileSync(join(source, '.gitignore'), 'ignored.log\n')
  for (const [name, contents] of Object.entries(extraFiles)) {
    writeFileSync(join(source, name), contents)
  }
  git(source, 'add', '.')
  git(source, 'commit', '--quiet', '-m', 'base')
  const head = git(source, 'rev-parse', 'HEAD').trim()
  const target = join(root, 'target')
  git(source, 'worktree', 'add', '--quiet', '-b', 'child', target, head)
  return { source, target }
}

// Why: a copyEntry that fails only on 'copy-b.txt' exercises the rollback path deterministically.
function ioFailingOnCopyB(overrides: Partial<WorkingTreeCarryIo> = {}): WorkingTreeCarryIo {
  return {
    ...io,
    copyEntry: async (fromRoot, toRoot, relativePath) => {
      if (relativePath === 'copy-b.txt') {
        throw new Error('simulated copy failure')
      }
      await copyNodeWorkingTreeEntry(fromRoot, toRoot, relativePath)
    },
    ...overrides
  }
}

// Why: simulates the parent agent committing after the HEAD check but before `stash create` runs.
function ioCommittingBeforeStash(source: string, commitArgs: string[]): WorkingTreeCarryIo {
  return {
    ...io,
    git: async (args, cwd) => {
      if (args.includes('stash') && args.includes('create')) {
        git(source, ...commitArgs)
      }
      return git(cwd, ...args)
    }
  }
}

describe('carryWorkingTreeChanges', () => {
  it('copies tracked edits, staged edits and new files without touching the source', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'tracked.txt'), 'edited\n')
    writeFileSync(join(source, 'staged.txt'), 'staged edit\n')
    git(source, 'add', 'staged.txt')
    mkdirSync(join(source, 'new-dir'))
    writeFileSync(join(source, 'new-dir', 'fresh.txt'), 'fresh\n')
    writeFileSync(join(source, 'ignored.log'), 'noise\n')
    const sourceStatusBefore = git(source, 'status', '--porcelain')

    const result = await carryWorkingTreeChanges(io, source, target)

    expect(result).toEqual({ ok: true, trackedChanges: true, untrackedCopied: 1 })
    expect(readFileSync(join(target, 'tracked.txt'), 'utf8')).toBe('edited\n')
    expect(readFileSync(join(target, 'staged.txt'), 'utf8')).toBe('staged edit\n')
    expect(readFileSync(join(target, 'new-dir', 'fresh.txt'), 'utf8')).toBe('fresh\n')
    expect(existsSync(join(target, 'ignored.log'))).toBe(false)
    expect(git(target, 'diff', '--cached', '--name-only')).toBe('')
    expect(git(source, 'status', '--porcelain')).toBe(sourceStatusBefore)
  })

  it('copies binary files and symlinks byte for byte', async () => {
    const { source, target } = createRepoWithChild()
    const binary = Buffer.from([0, 255, 1, 254, 0, 10, 13])
    writeFileSync(join(source, 'blob.bin'), binary)
    symlinkSync('tracked.txt', join(source, 'link-to-tracked'))
    writeFileSync(join(source, 'run.sh'), '#!/bin/sh\n')
    chmodSync(join(source, 'run.sh'), 0o755)

    const result = await carryWorkingTreeChanges(io, source, target)

    expect(result.ok).toBe(true)
    expect(readFileSync(join(target, 'blob.bin')).equals(binary)).toBe(true)
    expect(lstatSync(join(target, 'link-to-tracked')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(target, 'link-to-tracked'))).toBe('tracked.txt')
    if (process.platform !== 'win32') {
      expect(lstatSync(join(target, 'run.sh')).mode & 0o111).not.toBe(0)
    }
  })

  it('reports no tracked changes when only new files exist', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'only-new.txt'), 'x\n')
    expect(await carryWorkingTreeChanges(io, source, target)).toEqual({
      ok: true,
      trackedChanges: false,
      untrackedCopied: 1
    })
  })

  it('excludes an untracked nested repository from the carried files', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'tracked.txt'), 'edited\n')
    const nestedDir = join(source, 'nested')
    mkdirSync(nestedDir)
    git(nestedDir, 'init', '--quiet')
    writeFileSync(join(nestedDir, 'inner.txt'), 'inner\n')
    writeFileSync(join(source, 'plain.txt'), 'plain\n')

    const result = await carryWorkingTreeChanges(io, source, target)

    expect(result).toEqual({ ok: true, trackedChanges: true, untrackedCopied: 1 })
    expect(readFileSync(join(target, 'tracked.txt'), 'utf8')).toBe('edited\n')
    expect(readFileSync(join(target, 'plain.txt'), 'utf8')).toBe('plain\n')
    expect(existsSync(join(target, 'nested'))).toBe(false)
  })

  it('carries a staged deletion and a staged rename as unstaged changes', async () => {
    const { source, target } = createRepoWithChild({
      'to-delete.txt': 'gone\n',
      'to-rename.txt': 'renamed\n'
    })
    git(source, 'rm', '--quiet', 'to-delete.txt')
    git(source, 'mv', 'to-rename.txt', 'renamed.txt')

    const result = await carryWorkingTreeChanges(io, source, target)

    expect(result).toEqual({ ok: true, trackedChanges: true, untrackedCopied: 0 })
    expect(existsSync(join(target, 'to-delete.txt'))).toBe(false)
    expect(existsSync(join(target, 'to-rename.txt'))).toBe(false)
    expect(readFileSync(join(target, 'renamed.txt'), 'utf8')).toBe('renamed\n')
    expect(git(target, 'diff', '--cached', '--name-only')).toBe('')
  })

  it('refuses without writing when the target is on a different commit', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(target, 'tracked.txt'), 'target commit\n')
    git(target, 'commit', '--quiet', '-am', 'diverge')
    writeFileSync(join(source, 'tracked.txt'), 'edited\n')

    expect(await carryWorkingTreeChanges(io, source, target)).toEqual({
      ok: false,
      reason: 'base_mismatch'
    })
    expect(readFileSync(join(target, 'tracked.txt'), 'utf8')).toBe('target commit\n')
  })

  it('refuses without writing when the target already has changes', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(target, 'tracked.txt'), 'dirty\n')
    writeFileSync(join(source, 'new.txt'), 'x\n')

    expect(await carryWorkingTreeChanges(io, source, target)).toEqual({
      ok: false,
      reason: 'target_dirty'
    })
    expect(existsSync(join(target, 'new.txt'))).toBe(false)
  })

  it('refuses without writing when the target hides untracked files via config', async () => {
    const { source, target } = createRepoWithChild()
    git(target, 'config', 'status.showUntrackedFiles', 'no')
    writeFileSync(join(target, 'stray.txt'), 'stray\n')
    writeFileSync(join(source, 'new.txt'), 'x\n')

    expect(await carryWorkingTreeChanges(io, source, target)).toEqual({
      ok: false,
      reason: 'target_dirty'
    })
  })

  it('refuses without writing when new files exceed the size cap', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'new.txt'), 'x\n')
    const cappedIo: WorkingTreeCarryIo = { ...io, sumEntrySizes: async () => 201 * 1024 * 1024 }

    expect(await carryWorkingTreeChanges(cappedIo, source, target)).toEqual({
      ok: false,
      reason: 'too_large'
    })
    expect(existsSync(join(target, 'new.txt'))).toBe(false)
  })

  it('refuses without writing when new files exceed the count cap', async () => {
    const { source, target } = createRepoWithChild()
    for (let index = 0; index < CARRY_MAX_UNTRACKED_FILES + 1; index += 1) {
      writeFileSync(join(source, `new-${index}.txt`), 'x\n')
    }

    expect(await carryWorkingTreeChanges(io, source, target)).toEqual({
      ok: false,
      reason: 'too_large'
    })
    expect(existsSync(join(target, 'new-0.txt'))).toBe(false)
  })

  it('rolls back the target when a copy fails partway through', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'tracked.txt'), 'edited\n')
    writeFileSync(join(source, 'staged-new.txt'), 'staged\n')
    git(source, 'add', 'staged-new.txt')
    writeFileSync(join(source, 'copy-a.txt'), 'a\n')
    writeFileSync(join(source, 'copy-b.txt'), 'b\n')

    const result = await carryWorkingTreeChanges(ioFailingOnCopyB(), source, target)

    expect(result).toEqual({
      ok: false,
      reason: 'apply_failed',
      detail: expect.stringContaining('simulated copy failure')
    })
    expect(git(target, 'status', '--porcelain', '--untracked-files=normal')).toBe('')
    expect(readFileSync(join(target, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(existsSync(join(target, 'staged-new.txt'))).toBe(false)
    expect(existsSync(join(target, 'copy-a.txt'))).toBe(false)
  })

  it('reports partially_applied when the rollback itself fails', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'tracked.txt'), 'edited\n')
    writeFileSync(join(source, 'copy-a.txt'), 'a\n')
    writeFileSync(join(source, 'copy-b.txt'), 'b\n')
    const failingIo = ioFailingOnCopyB({
      removeEntry: async () => {
        throw new Error('simulated rollback failure')
      }
    })

    const result = await carryWorkingTreeChanges(failingIo, source, target)

    expect(result).toEqual({
      ok: false,
      reason: 'partially_applied',
      detail: expect.stringContaining('simulated copy failure')
    })
    if (!result.ok) {
      expect(result.detail).toContain('simulated rollback failure')
    }
  })

  it('rolls back a staged rename when a later copy fails', async () => {
    const { source, target } = createRepoWithChild({ 'to-rename.txt': 'base\n' })
    git(source, 'mv', 'to-rename.txt', 'renamed.txt')
    writeFileSync(join(source, 'copy-a.txt'), 'a\n')
    writeFileSync(join(source, 'copy-b.txt'), 'b\n')

    const result = await carryWorkingTreeChanges(ioFailingOnCopyB(), source, target)

    expect(result).toEqual({
      ok: false,
      reason: 'apply_failed',
      detail: expect.stringContaining('simulated copy failure')
    })
    expect(git(target, 'status', '--porcelain', '--untracked-files=normal')).toBe('')
    expect(existsSync(join(target, 'renamed.txt'))).toBe(false)
    expect(readFileSync(join(target, 'to-rename.txt'), 'utf8')).toBe('base\n')
  })

  it('refuses without writing when an untracked source file collides with an existing target file', async () => {
    const { source, target } = createRepoWithChild({ '.gitignore': 'ignored.log\n.env\n' })
    // Why: unstage the ignore rule so `.env` becomes an untracked (carriable) file in the source.
    writeFileSync(join(source, '.gitignore'), 'ignored.log\n')
    writeFileSync(join(source, '.env'), 'source-secret\n')
    writeFileSync(join(target, '.env'), 'target-secret\n')

    const result = await carryWorkingTreeChanges(io, source, target)

    expect(result).toEqual({ ok: false, reason: 'target_dirty' })
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe('target-secret\n')
    expect(git(target, 'status', '--porcelain', '--untracked-files=normal')).toBe('')
  })

  it('refuses without writing when a force-added staged file collides with an existing ignored target file', async () => {
    const { source, target } = createRepoWithChild({ '.gitignore': 'ignored.log\n.env\n' })
    writeFileSync(join(source, '.env'), 'source-secret\n')
    git(source, 'add', '-f', '.env')
    writeFileSync(join(target, '.env'), 'target-secret\n')

    const result = await carryWorkingTreeChanges(io, source, target)

    expect(result).toEqual({ ok: false, reason: 'target_dirty' })
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe('target-secret\n')
  })

  it('refuses without writing when the parent commits between the base check and the stash', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'tracked.txt'), 'edited\n')
    writeFileSync(join(source, 'staged.txt'), 'committed mid-carry\n')
    const racingIo = ioCommittingBeforeStash(source, [
      'commit',
      '--quiet',
      '-m',
      'mid',
      'staged.txt'
    ])

    expect(await carryWorkingTreeChanges(racingIo, source, target)).toEqual({
      ok: false,
      reason: 'base_mismatch'
    })
    expect(git(target, 'status', '--porcelain', '--untracked-files=normal')).toBe('')
    expect(readFileSync(join(target, 'tracked.txt'), 'utf8')).toBe('base\n')
  })

  it('refuses without writing when the parent commits every tracked edit before the stash', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'tracked.txt'), 'edited\n')
    writeFileSync(join(source, 'new.txt'), 'new\n')
    const racingIo = ioCommittingBeforeStash(source, ['commit', '--quiet', '-am', 'mid'])

    expect(await carryWorkingTreeChanges(racingIo, source, target)).toEqual({
      ok: false,
      reason: 'base_mismatch'
    })
    expect(existsSync(join(target, 'new.txt'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses without writing when a carried path sits under a symlinked target directory',
    async () => {
      const { source, target } = createRepoWithChild()
      const outside = join(source, '..', 'outside')
      mkdirSync(outside)
      symlinkSync('../outside', join(source, 'link'))
      git(source, 'add', 'link')
      git(source, 'commit', '--quiet', '-m', 'add link')
      git(target, 'reset', '--quiet', '--hard', git(source, 'rev-parse', 'HEAD').trim())
      // Why: the source swaps the tracked symlink for a real directory; stash create does not record that.
      rmSync(join(source, 'link'))
      mkdirSync(join(source, 'link'))
      writeFileSync(join(source, 'link', 'foo'), 'carried\n')

      const result = await carryWorkingTreeChanges(io, source, target)

      expect(result).toEqual({
        ok: false,
        reason: 'target_dirty',
        detail: 'A carried path is behind a symlinked folder: link/foo'
      })
      expect(existsSync(join(outside, 'foo'))).toBe(false)
      expect(lstatSync(join(target, 'link')).isSymbolicLink()).toBe(true)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'finishes rolling back when the applied stash turns a carried path into a symlinked folder',
    async () => {
      const { source, target } = createRepoWithChild({ d: 'file\n' })
      const outside = join(source, '..', 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'foo'), 'precious\n')
      // Why: the index type-changes `d` to a symlink, while the worktree holds a real `d/foo`.
      rmSync(join(source, 'd'))
      symlinkSync('../outside', join(source, 'd'))
      git(source, 'add', 'd')
      rmSync(join(source, 'd'))
      mkdirSync(join(source, 'd'))
      writeFileSync(join(source, 'd', 'foo'), 'new\n')

      const result = await carryWorkingTreeChanges(io, source, target)

      expect(result).toMatchObject({ ok: false, reason: 'apply_failed' })
      expect(readFileSync(join(outside, 'foo'), 'utf8')).toBe('precious\n')
      expect(lstatSync(join(target, 'd')).isFile()).toBe(true)
      expect(readFileSync(join(target, 'd'), 'utf8')).toBe('file\n')
      expect(git(target, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses to copy or remove through a symlinked target directory',
    async () => {
      const { target } = createRepoWithChild()
      const outside = join(target, '..', 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'foo'), 'precious\n')
      symlinkSync('../outside', join(target, 'link'))
      const source = mkdtempSync(join(tmpdir(), 'orca-carry-src-'))
      tempPaths.push(source)
      mkdirSync(join(source, 'link'))
      writeFileSync(join(source, 'link', 'bar'), 'carried\n')

      await expect(copyNodeWorkingTreeEntry(source, target, 'link/bar')).rejects.toMatchObject({
        code: CARRY_SYMLINKED_ANCESTOR_CODE
      })
      await expect(removeNodeWorkingTreeEntry(target, 'link/foo')).rejects.toThrow(/symlink/)
      expect(await nodeWorkingTreeEntryExists(target, 'link/foo')).toBe(true)
      expect(existsSync(join(outside, 'bar'))).toBe(false)
      expect(readFileSync(join(outside, 'foo'), 'utf8')).toBe('precious\n')
    }
  )

  it('removes carried paths before restoring tracked state during rollback', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'tracked.txt'), 'edited\n')
    writeFileSync(join(source, 'copy-a.txt'), 'a\n')
    writeFileSync(join(source, 'copy-b.txt'), 'b\n')
    const steps: string[] = []
    const failing = ioFailingOnCopyB()
    const recordingIo: WorkingTreeCarryIo = {
      ...failing,
      git: async (args, cwd) => {
        if (args.includes('--hard')) {
          steps.push('reset --hard')
        }
        return failing.git(args, cwd)
      },
      removeEntry: async (root, relativePath) => {
        steps.push(`remove ${relativePath}`)
        await failing.removeEntry(root, relativePath)
      }
    }

    expect(await carryWorkingTreeChanges(recordingIo, source, target)).toMatchObject({
      ok: false,
      reason: 'apply_failed'
    })
    // Why: a tracked symlink restored by reset would route the removals outside the target.
    expect(steps).toEqual(['remove copy-a.txt', 'remove copy-b.txt', 'reset --hard'])
  })

  it('keeps a target file that appeared mid-carry when copying onto it fails with EEXIST', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'copy-a.txt'), 'a\n')
    writeFileSync(join(source, 'copy-b.txt'), 'b\n')
    const racingIo: WorkingTreeCarryIo = {
      ...io,
      copyEntry: async (fromRoot, toRoot, relativePath) => {
        if (relativePath === 'copy-b.txt') {
          writeFileSync(join(toRoot, 'copy-b.txt'), 'not ours\n')
        }
        await copyNodeWorkingTreeEntry(fromRoot, toRoot, relativePath)
      }
    }

    const result = await carryWorkingTreeChanges(racingIo, source, target)

    expect(result).toMatchObject({ ok: false, reason: 'apply_failed' })
    expect(readFileSync(join(target, 'copy-b.txt'), 'utf8')).toBe('not ours\n')
    expect(existsSync(join(target, 'copy-a.txt'))).toBe(false)
  })

  it('removes a partially written file when its copy fails for another reason', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'copy-a.txt'), 'a\n')
    writeFileSync(join(source, 'copy-b.txt'), 'b\n')
    const failingIo: WorkingTreeCarryIo = {
      ...io,
      copyEntry: async (fromRoot, toRoot, relativePath) => {
        if (relativePath === 'copy-b.txt') {
          writeFileSync(join(toRoot, 'copy-b.txt'), 'partial')
          throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' })
        }
        await copyNodeWorkingTreeEntry(fromRoot, toRoot, relativePath)
      }
    }

    const result = await carryWorkingTreeChanges(failingIo, source, target)

    expect(result).toMatchObject({ ok: false, reason: 'apply_failed' })
    expect(existsSync(join(target, 'copy-b.txt'))).toBe(false)
    expect(git(target, 'status', '--porcelain', '--untracked-files=normal')).toBe('')
  })

  it('returns apply_failed instead of throwing when git cannot stash an intent-to-add file', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'tracked.txt'), 'edited\n')
    writeFileSync(join(source, 'intent.txt'), 'later\n')
    git(source, 'add', '-N', 'intent.txt')

    const result = await carryWorkingTreeChanges(io, source, target)

    expect(result).toEqual({
      ok: false,
      reason: 'apply_failed',
      detail: expect.stringContaining('intent.txt')
    })
    expect(git(target, 'status', '--porcelain', '--untracked-files=normal')).toBe('')
  })

  it('creates the stash with a fixed identity so hosts without user.email can carry', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'tracked.txt'), 'edited\n')
    const calls: string[][] = []
    const recordingIo: WorkingTreeCarryIo = {
      ...io,
      git: async (args, cwd) => {
        calls.push(args)
        return git(cwd, ...args)
      }
    }

    expect((await carryWorkingTreeChanges(recordingIo, source, target)).ok).toBe(true)
    expect(calls).toContainEqual([
      '-c',
      'user.name=Orca',
      '-c',
      'user.email=orca@localhost',
      'stash',
      'create'
    ])
  })
})

describe('normalizeWorkingTreeCarryResult', () => {
  it('keeps valid results and rejects garbage', () => {
    expect(
      normalizeWorkingTreeCarryResult({ ok: true, trackedChanges: true, untrackedCopied: 2 })
    ).toEqual({ ok: true, trackedChanges: true, untrackedCopied: 2 })
    expect(normalizeWorkingTreeCarryResult({ ok: false, reason: 'too_large' })).toEqual({
      ok: false,
      reason: 'too_large'
    })
    expect(
      normalizeWorkingTreeCarryResult({ ok: false, reason: 'partially_applied', detail: 'x' })
    ).toEqual({ ok: false, reason: 'partially_applied', detail: 'x' })
    expect(normalizeWorkingTreeCarryResult({ ok: false, reason: 'nope' })).toMatchObject({
      ok: false,
      reason: 'apply_failed'
    })
    expect(normalizeWorkingTreeCarryResult(null)).toMatchObject({
      ok: false,
      reason: 'apply_failed'
    })
  })

  it('accepts every failure reason the core can return', () => {
    for (const reason of [
      'base_mismatch',
      'target_dirty',
      'too_large',
      'apply_failed',
      'partially_applied'
    ] as const) {
      expect(normalizeWorkingTreeCarryResult({ ok: false, reason })).toEqual({ ok: false, reason })
    }
  })
})
