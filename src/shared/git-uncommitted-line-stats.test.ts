import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }))

vi.mock('fs/promises', () => ({ readFile: readFileMock }))

import {
  applyLineStats,
  collectUntrackedAdditions,
  parseNumstat
} from './git-uncommitted-line-stats'

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

  it('ignores blank lines', () => {
    expect(parseNumstat('').size).toBe(0)
  })
})

describe('collectUntrackedAdditions', () => {
  beforeEach(() => readFileMock.mockReset())

  it('counts file lines as additions, with or without a trailing newline', async () => {
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
    readFileMock.mockResolvedValue(Buffer.from(''))
    expect((await collectUntrackedAdditions('/repo', ['empty.ts'])).get('empty.ts')).toEqual({
      added: 0
    })
  })

  it('omits counts for binary files', async () => {
    readFileMock.mockResolvedValue(Buffer.from([0x00, 0x01, 0x02]))
    expect((await collectUntrackedAdditions('/repo', ['bin.dat'])).get('bin.dat')).toEqual({})
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
