import { describe, expect, it } from 'vitest'
import {
  normalizeWorktreeRootPathForTerminalLink,
  resolveKnownWorktreeRootPathLink
} from './terminal-worktree-path-link'

type WorktreeRootPathState = NonNullable<Parameters<typeof resolveKnownWorktreeRootPathLink>[1]>

function createState(
  worktreesByRepo: Record<string, { id: string; path: string }[]>
): WorktreeRootPathState {
  return { worktreesByRepo } as WorktreeRootPathState
}

describe('resolveKnownWorktreeRootPathLink', () => {
  it('resolves an exact known worktree root path', () => {
    const state = createState({
      repo: [{ id: 'wt-1', path: '/repo/feature' }]
    })

    expect(resolveKnownWorktreeRootPathLink('/repo/feature', state)).toEqual({
      id: 'wt-1',
      path: '/repo/feature'
    })
  })

  it('does not resolve an unknown directory path', () => {
    const state = createState({
      repo: [{ id: 'wt-1', path: '/repo/feature' }]
    })

    expect(resolveKnownWorktreeRootPathLink('/repo/other', state)).toBeNull()
  })

  it('does not resolve a path inside a known worktree', () => {
    const state = createState({
      repo: [{ id: 'wt-1', path: '/repo/feature' }]
    })

    expect(resolveKnownWorktreeRootPathLink('/repo/feature/src/main.ts', state)).toBeNull()
  })

  it('matches trailing separators without trimming filesystem roots', () => {
    const state = createState({
      repo: [
        { id: 'posix-root', path: '/' },
        { id: 'posix-wt', path: '/repo/feature' },
        { id: 'windows-root', path: 'C:\\' },
        { id: 'windows-wt', path: 'C:\\repo\\feature' }
      ]
    })

    expect(resolveKnownWorktreeRootPathLink('/repo/feature/', state)?.id).toBe('posix-wt')
    expect(resolveKnownWorktreeRootPathLink('C:\\repo\\feature\\', state)?.id).toBe('windows-wt')
    expect(normalizeWorktreeRootPathForTerminalLink('/')).toBe('/')
    expect(normalizeWorktreeRootPathForTerminalLink('C:\\')).toBe('C:/')
  })

  it('returns no match for duplicate root paths', () => {
    const state = createState({
      repo: [
        { id: 'wt-1', path: '/repo/feature' },
        { id: 'wt-2', path: '/repo/feature/' }
      ]
    })

    expect(resolveKnownWorktreeRootPathLink('/repo/feature', state)).toBeNull()
  })

  it('rebuilds the cached root index when worktreesByRepo is replaced', () => {
    const firstState = createState({
      repo: [{ id: 'wt-1', path: '/repo/feature' }]
    })
    const nextState = createState({
      repo: [{ id: 'wt-2', path: '/repo/feature' }]
    })

    expect(resolveKnownWorktreeRootPathLink('/repo/feature', firstState)?.id).toBe('wt-1')
    expect(resolveKnownWorktreeRootPathLink('/repo/feature', nextState)?.id).toBe('wt-2')
  })

  it('matches Windows paths across native and resolved separator styles', () => {
    const state = createState({
      repo: [{ id: 'wt-1', path: 'C:\\Users\\Alice\\Repo' }]
    })

    expect(resolveKnownWorktreeRootPathLink('C:\\Users\\Alice\\Repo\\', state)?.id).toBe('wt-1')
    expect(resolveKnownWorktreeRootPathLink('C:/Users/Alice/Repo', state)?.id).toBe('wt-1')
    expect(resolveKnownWorktreeRootPathLink('C:\\Users\\Alice\\Repo\\src', state)).toBeNull()
    expect(resolveKnownWorktreeRootPathLink('C:/Users/Alice/Repo/src', state)).toBeNull()
  })

  it('matches Windows and UNC roots case-insensitively without changing POSIX matching', () => {
    const state = createState({
      repo: [
        { id: 'wt-win', path: 'C:\\Users\\Alice\\Repo' },
        { id: 'wt-unc', path: '\\\\Server\\Share\\Repo' },
        { id: 'wt-posix', path: '/Users/Alice/Repo' }
      ]
    })

    expect(resolveKnownWorktreeRootPathLink('c:\\users\\alice\\repo', state)?.id).toBe('wt-win')
    expect(resolveKnownWorktreeRootPathLink('//server/share/repo', state)?.id).toBe('wt-unc')
    expect(resolveKnownWorktreeRootPathLink('/users/alice/repo', state)).toBeNull()
  })
})
