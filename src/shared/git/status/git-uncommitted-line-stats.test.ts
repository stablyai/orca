import { beforeEach, describe, expect, it, vi } from 'vitest'

const { lstatMock, readFileMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('fs/promises', () => ({ lstat: lstatMock }))

vi.mock('../../file-content/node-bounded-file-reader', () => ({
  readNodeFileWithinLimit: async (path: string) => ({
    buffer: await readFileMock(path),
    stats: mockFileStat(0)
  })
}))
import { collectUntrackedAdditions, parseNumstat } from './git-uncommitted-line-stats'

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
})

describe('collectUntrackedAdditions', () => {
  beforeEach(() => {
    lstatMock.mockReset()
    readFileMock.mockReset()
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

  it('rejects when the status request is aborted instead of returning partial counts', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      collectUntrackedAdditions('/repo', ['a.ts'], controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(lstatMock).not.toHaveBeenCalled()
  })
})
