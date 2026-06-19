import { beforeEach, describe, expect, it, vi } from 'vitest'

const { lstatMock, readFileMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('fs/promises', () => ({ lstat: lstatMock, readFile: readFileMock }))

import {
  applyLineStats,
  collectUntrackedAdditions,
  MAX_UNTRACKED_LINE_COUNT_BYTES,
  parseNumstat
} from './git-uncommitted-line-stats'

function mockFileStat(size: number, mtimeMs = 1) {
  return {
    size,
    mtimeMs,
    ctimeMs: mtimeMs,
    isFile: () => true,
    isSymbolicLink: () => false
  }
}

describe('parseNumstat', () => {
  it('parses added/removed counts keyed by path', () => {
    const stats = parseNumstat('3\t4\tsrc/app.ts\n10\t0\tsrc/new.ts\n')
    expect(stats.get('src/app.ts')).toEqual({ added: 3, removed: 4 })
    expect(stats.get('src/new.ts')).toEqual({ added: 10, removed: 0 })
  })

  it('treats binary "-" columns as undefined counts', () => {
    expect(parseNumstat('-\t-\tassets/logo.png\n').get('assets/logo.png')).toEqual({
      added: undefined,
      removed: undefined
    })
  })

  it('keys renames to the post-rename path', () => {
    const braced = parseNumstat('2\t1\tsrc/{old => new}/file.ts\n')
    expect(braced.get('src/new/file.ts')).toEqual({ added: 2, removed: 1 })
    const plain = parseNumstat('2\t1\told.ts => new.ts\n')
    expect(plain.get('new.ts')).toEqual({ added: 2, removed: 1 })
  })

  it('keeps literal rename-marker filenames when parsing NUL-delimited numstat', () => {
    const stats = parseNumstat('1\t0\tdocs/a => b.txt\0')

    expect(stats.get('docs/a => b.txt')).toEqual({ added: 1, removed: 0 })
  })

  it('keys NUL-delimited renames to the post-rename path', () => {
    const stats = parseNumstat('2\t1\t\0old.ts\0new.ts\0')

    expect(stats.get('new.ts')).toEqual({ added: 2, removed: 1 })
  })

  it('decodes Git C-quoted paths before keying stats', () => {
    expect(parseNumstat('1\t1\t"tab\\tfile.txt"\n').get('tab\tfile.txt')).toEqual({
      added: 1,
      removed: 1
    })
  })

  it('ignores blank lines', () => {
    expect(parseNumstat('').size).toBe(0)
  })
})

describe('collectUntrackedAdditions', () => {
  beforeEach(() => {
    lstatMock.mockReset()
    readFileMock.mockReset()
  })

  it('counts file lines as additions, with or without a trailing newline', async () => {
    lstatMock.mockImplementation((target: string) =>
      Promise.resolve(mockFileStat(String(target).endsWith('trailing.ts') ? 6 : 5))
    )
    readFileMock.mockImplementation((target: string) =>
      Promise.resolve(
        String(target).endsWith('trailing.ts') ? Buffer.from('a\nb\nc\n') : Buffer.from('a\nb\nc')
      )
    )
    const stats = await collectUntrackedAdditions('/repo', ['trailing.ts', 'no-trailing.ts'])
    expect(stats.get('trailing.ts')).toEqual({ added: 3 })
    expect(stats.get('no-trailing.ts')).toEqual({ added: 3 })
  })

  it('reports an empty file as zero additions', async () => {
    lstatMock.mockResolvedValue(mockFileStat(0))
    readFileMock.mockResolvedValue(Buffer.from(''))
    expect((await collectUntrackedAdditions('/repo', ['empty.ts'])).get('empty.ts')).toEqual({
      added: 0
    })
  })

  it('omits counts for binary files', async () => {
    lstatMock.mockResolvedValue(mockFileStat(3))
    readFileMock.mockResolvedValue(Buffer.from([0x00, 0x01, 0x02]))
    expect((await collectUntrackedAdditions('/repo', ['bin.dat'])).get('bin.dat')).toEqual({})
  })

  it('counts untracked symbolic links without following the target', async () => {
    lstatMock.mockResolvedValue({
      size: 4,
      mtimeMs: 2,
      ctimeMs: 2,
      isFile: () => false,
      isSymbolicLink: () => true
    })

    expect((await collectUntrackedAdditions('/repo', ['link.txt'])).get('link.txt')).toEqual({
      added: 1
    })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('skips oversized untracked files instead of reading them during status polling', async () => {
    lstatMock.mockResolvedValue(mockFileStat(MAX_UNTRACKED_LINE_COUNT_BYTES + 1, 3))

    expect((await collectUntrackedAdditions('/repo', ['large.log'])).get('large.log')).toEqual({})
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('reuses cached counts while size and mtime are unchanged', async () => {
    lstatMock.mockResolvedValue(mockFileStat(5, 4))
    readFileMock.mockResolvedValue(Buffer.from('a\nb\nc'))

    await collectUntrackedAdditions('/repo', ['cached.ts'])
    const stats = await collectUntrackedAdditions('/repo', ['cached.ts'])

    expect(stats.get('cached.ts')).toEqual({ added: 3 })
    expect(readFileMock).toHaveBeenCalledTimes(1)
  })
})

describe('applyLineStats', () => {
  it('copies defined counts onto the entry', () => {
    const entry: { added?: number; removed?: number } = {}
    applyLineStats(entry, { added: 5, removed: 2 })
    expect(entry).toEqual({ added: 5, removed: 2 })
  })

  it('leaves the entry untouched for undefined counts or missing stats', () => {
    const entry: { added?: number; removed?: number } = {}
    applyLineStats(entry, { added: undefined, removed: undefined })
    applyLineStats(entry, undefined)
    expect(entry).toEqual({})
  })
})
