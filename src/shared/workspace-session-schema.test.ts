import { describe, it, expect } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'

describe('parseWorkspaceSession', () => {
  it('accepts a minimal valid session', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    })
    expect(result.ok).toBe(true)
  })

  it('accepts a fully populated session with optional fields', () => {
    const result = parseWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: 'repo1::/path/wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        'repo1::/path/wt1': [
          {
            id: 'tab1',
            ptyId: 'daemon-session-abc',
            worktreeId: 'repo1::/path/wt1',
            title: 'bash',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1_700_000_000_000
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: 'pane:1' },
            second: { type: 'leaf', leafId: 'pane:2' }
          },
          activeLeafId: 'pane:1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'pane:1': 'daemon-session-A' }
        }
      },
      activeWorktreeIdsOnShutdown: ['repo1::/path/wt1']
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a session where ptyId is a number (schema drift)', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {
        wt: [
          {
            id: 'tab1',
            ptyId: 42,
            worktreeId: 'wt',
            title: 'bash',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('ptyId')
    }
  })

  it('rejects a session with missing required top-level fields', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null
      // missing activeWorktreeId, tabsByWorktree, etc.
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a truncated JSON object', () => {
    const result = parseWorkspaceSession({})
    expect(result.ok).toBe(false)
  })

  it('rejects non-object input (e.g. corrupted file contents)', () => {
    expect(parseWorkspaceSession(null).ok).toBe(false)
    expect(parseWorkspaceSession('garbage').ok).toBe(false)
    expect(parseWorkspaceSession(42).ok).toBe(false)
  })

  it('drops bad lastVisitedAtByWorktreeId entries rather than failing the session', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      lastVisitedAtByWorktreeId: {
        good: 1_700_000_000_000,
        nan: Number.NaN,
        infinite: Number.POSITIVE_INFINITY,
        negative: -5,
        string: 'nope'
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.lastVisitedAtByWorktreeId).toEqual({ good: 1_700_000_000_000 })
    }
  })
})
