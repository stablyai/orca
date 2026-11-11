import { describe, it, expect } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'
import { MAX_BROWSER_HISTORY_ENTRIES } from './workspace-session-browser-history'

describe('parseWorkspaceSession', () => {
  it('drops one truncated tab without discarding other persisted worktrees', () => {
    const validTab = {
      id: 'tab-good',
      ptyId: null,
      worktreeId: 'worktree-good',
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1_700_000_000_000
    }
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'worktree-good',
      activeTabId: 'tab-good',
      tabsByWorktree: {
        'worktree-good': [validTab],
        'worktree-corrupt': [
          {
            id: 'tab-truncated',
            ptyId: null,
            worktreeId: 'worktree-corrupt',
            title: 'Terminal',
            sortOrder: 0,
            generation: 3,
            startupCwd: '/workspace'
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree).toEqual({
        'worktree-good': [validTab],
        'worktree-corrupt': []
      })
    }
  })

  it('caps oversized browser history while parsing legacy workspace sessions', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserUrlHistory: Array.from({ length: 500 }, (_, index) => ({
        url: `https://example.com/${index}`,
        normalizedUrl: `https://example.com/${index}`,
        title: `Example ${index}`,
        faviconUrl: index === 0 ? 'https://example.com/favicon.ico' : null,
        lastVisitedAt: 1_700_000_000_000 - index,
        visitCount: 1
      }))
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.browserUrlHistory).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES)
      expect(result.value.browserUrlHistory?.[0]?.faviconUrl).toBe(
        'https://example.com/favicon.ico'
      )
      expect(result.value.browserUrlHistory?.at(-1)?.url).toBe('https://example.com/199')
    }
  })

  it('keeps launchAgent and its stable leaf on a persisted terminal tab', () => {
    const leafId = '77777777-7777-4777-8777-777777777777'
    const tab = {
      id: 'tab-codex',
      ptyId: null,
      worktreeId: 'worktree-codex',
      title: 'demo-repo',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1_700_000_000_000,
      launchAgent: 'codex',
      launchAgentLeafId: leafId
    }
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'worktree-codex',
      activeTabId: 'tab-codex',
      tabsByWorktree: { 'worktree-codex': [tab] },
      terminalLayoutsByTabId: {}
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree['worktree-codex']?.[0]?.launchAgent).toBe('codex')
      expect(result.value.tabsByWorktree['worktree-codex']?.[0]?.launchAgentLeafId).toBe(leafId)
    }
  })
})
