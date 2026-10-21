import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  resolveChecksPanelTerminalPtyId,
  resolveChecksPanelWorktreeFromTerminalCwd
} from './checks-panel-terminal-worktree'

function worktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: overrides.id ?? `repo-1::${overrides.path ?? '/repo'}`,
    repoId: overrides.repoId ?? 'repo-1',
    path: overrides.path ?? '/repo',
    displayName: overrides.displayName ?? 'Repo',
    priorWorktreeIds: overrides.priorWorktreeIds,
    isArchived: overrides.isArchived ?? false
  } as Worktree
}

describe('resolveChecksPanelTerminalPtyId', () => {
  it('uses the active split-pane leaf when it has a live PTY', () => {
    expect(
      resolveChecksPanelTerminalPtyId({
        activeTabId: 'tab-1',
        ptyIdsByTabId: { 'tab-1': ['pty-left', 'pty-right'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: null,
            activeLeafId: 'leaf-right',
            expandedLeafId: null,
            ptyIdsByLeafId: {
              'leaf-left': 'pty-left',
              'leaf-right': 'pty-right'
            }
          }
        }
      })
    ).toBe('pty-right')
  })

  it('falls back to a live layout PTY before using the last live tab PTY', () => {
    expect(
      resolveChecksPanelTerminalPtyId({
        activeTabId: 'tab-1',
        ptyIdsByTabId: { 'tab-1': ['pty-live', 'pty-other'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: null,
            activeLeafId: 'leaf-stale',
            expandedLeafId: null,
            ptyIdsByLeafId: {
              'leaf-stale': 'pty-stale',
              'leaf-live': 'pty-live'
            }
          }
        }
      })
    ).toBe('pty-live')
  })

  it('falls back to the last live tab PTY when the layout has no live PTY', () => {
    expect(
      resolveChecksPanelTerminalPtyId({
        activeTabId: 'tab-1',
        ptyIdsByTabId: { 'tab-1': ['pty-left', 'pty-right'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: null,
            activeLeafId: 'leaf-stale',
            expandedLeafId: null,
            ptyIdsByLeafId: {
              'leaf-stale': 'pty-stale'
            }
          }
        }
      })
    ).toBe('pty-right')
  })

  it('returns null when the active tab has no live PTY', () => {
    expect(
      resolveChecksPanelTerminalPtyId({
        activeTabId: 'tab-1',
        ptyIdsByTabId: { 'tab-1': [] },
        terminalLayoutsByTabId: {}
      })
    ).toBeNull()
  })
})

describe('resolveChecksPanelWorktreeFromTerminalCwd', () => {
  it('matches the deepest worktree that contains the terminal cwd', () => {
    const parent = worktree({ id: 'repo-1::/repo', path: '/repo', displayName: 'Parent' })
    const child = worktree({
      id: 'repo-1::/repo/packages/app',
      path: '/repo/packages/app',
      displayName: 'Child'
    })

    expect(
      resolveChecksPanelWorktreeFromTerminalCwd('/repo/packages/app/src', [parent, child])
    ).toBe(child)
  })

  it('does not match a sibling whose path is a string prefix of the cwd', () => {
    const app = worktree({ id: 'repo-1::/repo/app', path: '/repo/app', displayName: 'App' })
    const application = worktree({
      id: 'repo-1::/repo/application',
      path: '/repo/application',
      displayName: 'Application'
    })

    // `/repo/application` starts with `/repo/app` as a string, but the
    // separator boundary must keep the cwd from matching the shorter sibling.
    expect(
      resolveChecksPanelWorktreeFromTerminalCwd('/repo/application/src', [app, application])
    ).toBe(application)
  })

  it('matches prior worktree paths after a path-derived id changes', () => {
    const renamed = worktree({
      id: 'repo-1::/new/path',
      path: '/new/path',
      priorWorktreeIds: ['repo-1::/old/path']
    })

    expect(resolveChecksPanelWorktreeFromTerminalCwd('/old/path/src', [renamed])).toBe(renamed)
  })

  it('matches Linux cwd under a WSL UNC worktree path', () => {
    const wsl = worktree({
      id: 'repo-1:://wsl.localhost/Ubuntu/home/me/project',
      path: '//wsl.localhost/Ubuntu/home/me/project'
    })

    expect(resolveChecksPanelWorktreeFromTerminalCwd('/home/me/project/src', [wsl])).toBe(wsl)
  })

  it('does not match relative or empty cwd values', () => {
    const target = worktree({ path: '/repo' })

    expect(resolveChecksPanelWorktreeFromTerminalCwd('repo/src', [target])).toBeNull()
    expect(resolveChecksPanelWorktreeFromTerminalCwd('', [target])).toBeNull()
  })
})

it('selects the deepest cwd match without comparator-time path normalization', () => {
  const worktrees = Array.from({ length: 300 }, (_, i) =>
    worktree({
      id: String(i),
      path: `/repo${'/a'.repeat((i * 173) % 300)}`
    })
  )
  const deepest = worktrees.find((candidate) => candidate.path.length === '/repo'.length + 299 * 2)
  const normalize = vi.spyOn(String.prototype, 'normalize')
  try {
    expect(resolveChecksPanelWorktreeFromTerminalCwd(`/repo${'/a'.repeat(300)}`, worktrees)).toBe(
      deepest
    )
    expect(normalize.mock.calls.length).toBeLessThanOrEqual(901)
  } finally {
    normalize.mockRestore()
  }
})

it('normalizes only the cwd, each root, and the matching path when roots do not nest', () => {
  const worktrees = Array.from({ length: 300 }, (_, i) =>
    worktree({ id: String(i), path: `/repo/w${i}` })
  )
  const normalize = vi.spyOn(String.prototype, 'normalize')
  try {
    expect(resolveChecksPanelWorktreeFromTerminalCwd('/repo/w150/src/a', worktrees)?.id).toBe('150')
    // 1 cwd + 300 candidate roots + 1 matched path; main normalized 600.
    expect(normalize.mock.calls.length).toBe(302)
  } finally {
    normalize.mockRestore()
  }
})
