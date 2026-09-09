import { afterEach, describe, expect, it, vi } from 'vitest'
import { readGitBlamePreference, writeGitBlamePreference } from './git-blame-preference'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Git blame preference storage', () => {
  it('defaults to enabled when browser storage is absent', () => {
    vi.stubGlobal('localStorage', undefined)

    expect(readGitBlamePreference('worktree-1')).toBe(true)
    expect(() => writeGitBlamePreference('worktree-1', false)).not.toThrow()
  })

  it('keeps working when browser storage access is denied', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new DOMException('Storage denied', 'SecurityError')
      }),
      setItem: vi.fn(() => {
        throw new DOMException('Storage denied', 'SecurityError')
      })
    })

    expect(readGitBlamePreference('worktree-1')).toBe(true)
    expect(() => writeGitBlamePreference('worktree-1', false)).not.toThrow()
  })

  it('honors an explicit disabled preference', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'false'),
      setItem: vi.fn()
    })

    expect(readGitBlamePreference('worktree-1')).toBe(false)
  })
})
