import { beforeEach, describe, expect, it, vi } from 'vitest'

const { lstatMock, opendirMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  opendirMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  opendir: opendirMock
}))

import { readQuickOpenDirectoryEntries } from './quick-open-directory-reader'
import { createQuickOpenReaddirBudget } from './quick-open-readdir-budget'

beforeEach(() => {
  vi.clearAllMocks()
  lstatMock.mockResolvedValue({
    isDirectory: () => true,
    isSymbolicLink: () => false
  })
})

describe('quick-open streaming directory reader', () => {
  it('orders numbered entries naturally before the recursive walk', async () => {
    opendirMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        for (const name of ['100 - notes', '9 - notes', '99 - notes']) {
          yield {
            name,
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => false
          }
        }
      }
    })

    const entries = await readQuickOpenDirectoryEntries({
      absPath: '/numbered',
      allowSymlinkedRoot: false,
      budget: createQuickOpenReaddirBudget()
    })

    expect(entries.map((entry) => entry.name)).toEqual(['9 - notes', '99 - notes', '100 - notes'])
  })

  it('stops a huge directory one entry beyond the exact cap and closes its iterator', async () => {
    let produced = 0
    let closed = false
    opendirMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        try {
          while (produced < 1_000_000) {
            produced += 1
            yield {
              name: `directory-${produced}`,
              isDirectory: () => true,
              isFile: () => false,
              isSymbolicLink: () => false
            }
          }
        } finally {
          closed = true
        }
      }
    })

    await expect(
      readQuickOpenDirectoryEntries({
        absPath: '/streamed',
        allowSymlinkedRoot: false,
        budget: createQuickOpenReaddirBudget({ maxEntries: 3 })
      })
    ).rejects.toThrow('File listing exceeded 3 entries')
    expect(produced).toBe(4)
    expect(closed).toBe(true)
  })
})
