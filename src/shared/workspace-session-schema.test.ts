import { describe, it, expect } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'
import { MAX_BROWSER_HISTORY_ENTRIES } from './workspace-session-browser-history'

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

  it('preserves an isolated browser tab session partition across hydration', () => {
    // Regression for #6923: the resolved partition must survive persist→load,
    // otherwise a restored isolated tab falls back to the shared default
    // partition when the renderer profile mirror is stale at startup.
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        wt: [
          {
            id: 'browser-1',
            worktreeId: 'wt',
            sessionProfileId: 'iso-profile',
            sessionPartition: 'persist:orca-browser-session-iso-profile',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.browserTabsByWorktree?.wt?.[0]?.sessionPartition).toBe(
      'persist:orca-browser-session-iso-profile'
    )
  })

  it('preserves a valid launchAgent on a terminal tab', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {
        wt: [
          {
            id: 'tab1',
            ptyId: null,
            worktreeId: 'wt',
            title: 'codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            launchAgent: 'codex'
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt[0].launchAgent).toBe('codex')
    }
  })

  it('drops an unknown launchAgent without failing the whole session', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {
        wt: [
          {
            id: 'tab1',
            ptyId: null,
            worktreeId: 'wt',
            title: 'bash',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            launchAgent: 'some-retired-agent'
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt[0].launchAgent).toBeUndefined()
    }
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

  it('preserves generated terminal title fields for persistence hydration', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt: [
          {
            id: 'tab1',
            ptyId: null,
            worktreeId: 'wt',
            title: 'Claude working',
            defaultTitle: 'Terminal 1',
            generatedTitle: 'Refactor auth',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      terminalLayoutsByTabId: {},
      unifiedTabs: {
        wt: [
          {
            id: 'tab1',
            entityId: 'tab1',
            groupId: 'group1',
            worktreeId: 'wt',
            contentType: 'terminal',
            label: 'Claude working',
            generatedLabel: 'Refactor auth',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt[0].generatedTitle).toBe('Refactor auth')
      expect(result.value.unifiedTabs?.wt[0].generatedLabel).toBe('Refactor auth')
    }
  })

  it('preserves quick command label fields while accepting older omitted fields', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt: [
          {
            id: 'tab1',
            ptyId: null,
            worktreeId: 'wt',
            title: 'pnpm test',
            defaultTitle: 'Terminal 1',
            quickCommandLabel: 'Run tests',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          },
          {
            id: 'tab2',
            ptyId: null,
            worktreeId: 'wt',
            title: 'Terminal 2',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {},
      unifiedTabs: {
        wt: [
          {
            id: 'tab1',
            entityId: 'tab1',
            groupId: 'group1',
            worktreeId: 'wt',
            contentType: 'terminal',
            label: 'pnpm test',
            quickCommandLabel: 'Run tests',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt[0].quickCommandLabel).toBe('Run tests')
      expect(result.value.tabsByWorktree.wt[1].quickCommandLabel).toBeUndefined()
      expect(result.value.unifiedTabs?.wt[0].quickCommandLabel).toBe('Run tests')
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

  it('accepts default-tab idempotency markers', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      defaultTerminalTabsAppliedByWorktreeId: {
        'repo1::/path/wt1': true
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.defaultTerminalTabsAppliedByWorktreeId).toEqual({
        'repo1::/path/wt1': true
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
        lastVisitedAt: 1_700_000_000_000 - index,
        visitCount: 1
      }))
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.browserUrlHistory).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES)
      expect(result.value.browserUrlHistory?.at(-1)?.url).toBe('https://example.com/199')
    }
  })

  it('preserves a known viewMode on a unified tab', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      unifiedTabs: {
        wt: [
          {
            id: 'tab1',
            entityId: 'tab1',
            groupId: 'group1',
            worktreeId: 'wt',
            contentType: 'terminal',
            label: 'Claude',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            viewMode: 'chat'
          }
        ]
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.unifiedTabs?.wt[0].viewMode).toBe('chat')
    }
  })

  it('degrades an unknown viewMode to the safe default instead of failing parse', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      unifiedTabs: {
        wt: [
          {
            id: 'tab1',
            entityId: 'tab1',
            groupId: 'group1',
            worktreeId: 'wt',
            contentType: 'terminal',
            label: 'Claude',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            // A newer build could persist a mode this version doesn't know.
            viewMode: 'split-future-mode'
          }
        ]
      }
    })
    // The whole-session parse must still succeed; the unknown mode degrades.
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.unifiedTabs?.wt[0].viewMode).toBe('terminal')
    }
  })

  it('preserves a tasks tab across session parse', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      unifiedTabs: {
        wt: [
          {
            id: 'tasks-1',
            entityId: 'tasks-1',
            groupId: 'group1',
            worktreeId: 'wt',
            contentType: 'tasks',
            label: 'Tasks',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.unifiedTabs?.wt[0].contentType).toBe('tasks')
    }
  })
})
