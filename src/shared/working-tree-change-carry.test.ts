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
import { carryWorkingTreeChanges, type WorkingTreeCarryIo } from './working-tree-change-carry'
import { copyNodeWorkingTreeEntry, sumNodeEntrySizes } from './working-tree-change-carry-node-fs'

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
  copyEntry: copyNodeWorkingTreeEntry
}

function createRepoWithChild(): { source: string; target: string } {
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
  git(source, 'add', '.')
  git(source, 'commit', '--quiet', '-m', 'base')
  const head = git(source, 'rev-parse', 'HEAD').trim()
  const target = join(root, 'target')
  git(source, 'worktree', 'add', '--quiet', '-b', 'child', target, head)
  return { source, target }
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

  it('refuses without writing when there are too many new files', async () => {
    const { source, target } = createRepoWithChild()
    writeFileSync(join(source, 'new.txt'), 'x\n')
    const cappedIo: WorkingTreeCarryIo = { ...io, sumEntrySizes: async () => 201 * 1024 * 1024 }

    expect(await carryWorkingTreeChanges(cappedIo, source, target)).toEqual({
      ok: false,
      reason: 'too_large'
    })
    expect(existsSync(join(target, 'new.txt'))).toBe(false)
  })
})
