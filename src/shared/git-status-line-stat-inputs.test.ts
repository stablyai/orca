import { describe, expect, it } from 'vitest'
import { collectGitStatusLineStatInputs } from './git-status-line-stat-inputs'

describe('collectGitStatusLineStatInputs', () => {
  it('classifies mixed status entries without changing path order', () => {
    expect(
      collectGitStatusLineStatInputs([
        { area: 'staged', path: 'staged.ts' },
        { area: 'untracked', path: 'first.txt' },
        { area: 'unstaged', path: 'unstaged.ts' },
        { area: 'untracked', path: 'second.txt' },
        { area: 'ignored', path: 'ignored.log' }
      ])
    ).toEqual({
      hasStaged: true,
      hasUnstaged: true,
      untrackedPaths: ['first.txt', 'second.txt']
    })
  })

  it('reads each of 1,000 untracked entries once', () => {
    let areaReads = 0
    let pathReads = 0
    const entries = Array.from({ length: 1_000 }, (_, index) => {
      const entry: { area: unknown; path: unknown } = { area: undefined, path: undefined }
      Object.defineProperties(entry, {
        area: {
          enumerable: true,
          get: () => {
            areaReads += 1
            return 'untracked'
          }
        },
        path: {
          enumerable: true,
          get: () => {
            pathReads += 1
            return `file-${index}.txt`
          }
        }
      })
      return entry
    })

    const result = collectGitStatusLineStatInputs(entries)

    expect(areaReads).toBe(1_000)
    expect(pathReads).toBe(1_000)
    expect(result).toEqual({
      hasStaged: false,
      hasUnstaged: false,
      untrackedPaths: Array.from({ length: 1_000 }, (_, index) => `file-${index}.txt`)
    })
  })
})
