import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as Fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { directoryEntryNeedsStat, scanSourceTree } from './source-tree-scan'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync)
  }
})

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-source-tree-walk-'))
  vi.mocked(readdirSync).mockReset()
  vi.mocked(statSync).mockClear()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function file(relativePath: string, contents = relativePath): void {
  writeFileSync(join(root, relativePath), contents)
}

describe('scanSourceTree filesystem traversal', () => {
  it('reads nested source files without stat calls for ordinary directory entries', () => {
    mkdirSync(join(root, 'nested'))
    file('first.ts')
    file(join('nested', 'second.tsx'), 'nested/second.tsx')
    file('ignored.txt')
    file('first.test.ts')

    const files = scanSourceTree(root)

    // readdir order is filesystem-dependent (tmpfs differs from APFS/ext4).
    expect(files).toHaveLength(2)
    expect(files).toEqual(
      expect.arrayContaining([
        { path: join(root, 'first.ts'), relativePath: 'first.ts', source: 'first.ts' },
        {
          path: join(root, 'nested', 'second.tsx'),
          relativePath: 'nested/second.tsx',
          source: 'nested/second.tsx'
        }
      ])
    )
    expect(statSync).not.toHaveBeenCalled()
  })

  it('keeps ignored directories, dotfiles, and test exclusions out of the inventory', () => {
    for (const directory of ['node_modules', 'dist', 'out', 'build', '.cache', '__fixtures__']) {
      mkdirSync(join(root, directory))
      file(join(directory, 'hidden.ts'))
    }
    file('.hidden.ts')
    file('sample.test.ts')
    file('sample.spec.tsx')
    file('test-harness.ts')
    file('production.ts')

    expect(scanSourceTree(root).map((entry) => entry.relativePath)).toEqual(['production.ts'])
  })

  it('keeps extension and test-inclusion options', () => {
    file('module.mjs')
    file('module.ts')
    file('module.test.ts')

    expect(
      scanSourceTree(root, { includeTests: true })
        .map((entry) => entry.relativePath)
        .sort()
    ).toEqual(['module.test.ts', 'module.ts'])
    expect(
      scanSourceTree(root, { extensions: /\.mjs$/ }).map((entry) => entry.relativePath)
    ).toEqual(['module.mjs'])
  })

  it('follows directory links with stat while preserving the lexical path', () => {
    const target = join(root, '.target')
    mkdirSync(target)
    writeFileSync(join(target, 'linked.ts'), 'linked source')
    symlinkSync(target, join(root, 'alias'), 'junction')

    expect(scanSourceTree(root)).toEqual([
      {
        path: join(root, 'alias', 'linked.ts'),
        relativePath: 'alias/linked.ts',
        source: 'linked source'
      }
    ])
    expect(statSync).toHaveBeenCalledExactlyOnceWith(join(root, 'alias'))
  })


  it('still reports a broken link instead of silently dropping it', () => {
    const target = join(root, '.target')
    mkdirSync(target)
    symlinkSync(target, join(root, 'alias'), 'junction')
    rmSync(target, { recursive: true })

    expect(() => scanSourceTree(root)).toThrow(/ENOENT/)
    expect(statSync).toHaveBeenCalledExactlyOnceWith(join(root, 'alias'))
  })
})

describe('directoryEntryNeedsStat', () => {
  const probe = (kind: 'file' | 'dir' | 'link' | 'unknown') => ({
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'link'
  })

  it('skips the stat for entries readdir already typed', () => {
    expect(directoryEntryNeedsStat(probe('file'))).toBe(false)
    expect(directoryEntryNeedsStat(probe('dir'))).toBe(false)
  })

  it('stats links so they are followed', () => {
    expect(directoryEntryNeedsStat(probe('link'))).toBe(true)
  })

  // Filesystems without d_type report DT_UNKNOWN: every predicate is false, and
  // without the stat a real directory's whole subtree is silently dropped.
  it('stats an entry whose type readdir could not report', () => {
    expect(directoryEntryNeedsStat(probe('unknown'))).toBe(true)
  })
})
