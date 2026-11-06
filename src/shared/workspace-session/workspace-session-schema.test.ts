import { describe, it, expect } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'
import { MAX_BROWSER_HISTORY_ENTRIES } from './workspace-session-browser-history'

describe('parseWorkspaceSession', () => {
  it('preserves external SSH file ownership across session parsing', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        wt: [
          {
            filePath: '/tmp/external.png',
            relativePath: '/tmp/external.png',
            worktreeId: 'wt',
            language: 'png',
            externalSshTargetId: 'ssh-1'
          }
        ]
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.openFilesByWorktree?.wt?.[0]?.externalSshTargetId).toBe('ssh-1')
    }
  })

  it('drops an open file with blank external SSH ownership, keeping the session', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        wt: [
          {
            filePath: '/tmp/external.png',
            relativePath: '/tmp/external.png',
            worktreeId: 'wt',
            language: 'png',
            externalSshTargetId: '   '
          }
        ]
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.openFilesByWorktree?.wt).toEqual([])
    }
  })

  it('preserves an isolated browser tab session partition across hydration', () => {
    // Preserve isolated storage despite a stale renderer profile mirror after restart (#6923).
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

  it('drops a launch pane an older build saved: after a restart its pane is an ordinary pane', () => {
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
            title: 'claude',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            launchAgent: 'claude',
            agentLaunchPane: { leafId: 'leaf-1', outcome: { kind: 'not-started', code: 'boom' } }
          },
          {
            id: 'tab2',
            ptyId: null,
            worktreeId: 'wt',
            title: 'claude',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 1,
            agentLaunchPane: { leafId: 'leaf-2', outcome: { kind: 'exploded' } }
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt[0]).not.toHaveProperty('agentLaunchPane')
      expect(result.value.tabsByWorktree.wt[1]).not.toHaveProperty('agentLaunchPane')
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
            aiVaultTitle: {
              agent: 'codex',
              sessionId: 'session-1',
              title: 'Provider thread name',
              kind: 'named'
            },
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
            executionHostId: 'runtime:host-b',
            contentType: 'terminal',
            label: 'Claude working',
            generatedLabel: 'Refactor auth',
            aiVaultTitle: {
              agent: 'codex',
              sessionId: 'session-1',
              title: 'Provider thread name',
              kind: 'unknown-future-kind'
            },
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
      expect(result.value.tabsByWorktree.wt[0].aiVaultTitle?.title).toBe('Provider thread name')
      // The kind survives a restore, so a session's name still outranks a quick-command label.
      expect(result.value.tabsByWorktree.wt[0].aiVaultTitle?.kind).toBe('named')
      expect(result.value.unifiedTabs?.wt[0].generatedLabel).toBe('Refactor auth')
      expect(result.value.unifiedTabs?.wt[0].aiVaultTitle?.title).toBe('Provider thread name')
      // An unknown kind from a newer build keeps the title, unclassified.
      expect(result.value.unifiedTabs?.wt[0].aiVaultTitle?.kind).toBeUndefined()
      expect(result.value.unifiedTabs?.wt[0].executionHostId).toBe('runtime:host-b')
    }
  })

  it('drops malformed AI Vault titles without rejecting the workspace session', () => {
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
            title: 'Codex',
            aiVaultTitle: { agent: 'future-agent', sessionId: 'session-1', title: 'Name' },
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
            label: 'Codex',
            aiVaultTitle: 'malformed',
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
      expect(result.value.tabsByWorktree.wt[0].aiVaultTitle).toBeUndefined()
      expect(result.value.unifiedTabs?.wt[0].aiVaultTitle).toBeUndefined()
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

  it('preserves a structured agent session tab and drops the retired adoption key', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: 'session-1',
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      unifiedTabs: {
        wt: [
          {
            id: 'session-1',
            entityId: 'session-1',
            groupId: 'group1',
            worktreeId: 'wt',
            contentType: 'agent-session',
            agentSessionAgent: 'codex',
            label: 'Codex Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          },
          {
            id: 'terminal-1',
            entityId: 'terminal-1',
            groupId: 'group1',
            worktreeId: 'wt',
            contentType: 'terminal',
            viewMode: 'chat',
            // Why: older builds could save this key on a chat-mode terminal; it must keep loading.
            structuredSessionId: 'codex-session-1',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 0
          }
        ]
      },
      activeTabTypeByWorktree: { wt: 'agent-session' }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.unifiedTabs?.wt[0]).toMatchObject({
        contentType: 'agent-session',
        agentSessionAgent: 'codex'
      })
      expect(result.value.unifiedTabs?.wt[1]).toMatchObject({
        contentType: 'terminal',
        viewMode: 'chat'
      })
      expect(result.value.unifiedTabs?.wt[1]).not.toHaveProperty('structuredSessionId')
      expect(result.value.activeTabTypeByWorktree?.wt).toBe('agent-session')
    }
  })

  it('keeps a chat tab of any agent id, and drops only a malformed id', () => {
    const chatTab = (id: string, agentSessionAgent: unknown) => ({
      id,
      entityId: id,
      groupId: 'group1',
      worktreeId: 'wt',
      contentType: 'agent-session',
      agentSessionAgent,
      label: 'Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    })
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      unifiedTabs: {
        wt: [
          chatTab('a', 'grok'),
          chatTab('b', 'not an agent!'),
          chatTab('c', 42),
          chatTab('d', 'claude')
        ]
      }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.unifiedTabs?.wt.map((tab) => [tab.id, tab.agentSessionAgent])).toEqual([
        ['a', 'grok'],
        ['b', undefined],
        ['c', undefined],
        ['d', 'claude']
      ])
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

  // Reclaiming client-hosted pages after relaunch requires both persisted identity fields; z.object drops unlisted fields.
  it('preserves the remote page identity of a client-hosted browser page', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserPagesByWorkspace: {
        'workspace-1': [
          {
            id: 'page-1',
            workspaceId: 'workspace-1',
            worktreeId: 'wt',
            url: 'https://example.com/',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1,
            browserRuntimeEnvironmentId: 'env-1',
            remoteBrowserPageId: 'remote-page-1',
            remoteBrowserPageClientHosted: true
          }
        ]
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.browserPagesByWorkspace?.['workspace-1']?.[0]).toMatchObject({
        remoteBrowserPageId: 'remote-page-1',
        remoteBrowserPageClientHosted: true
      })
    }
  })

  it('accepts a browser page persisted before the remote page identity existed', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserPagesByWorkspace: {
        'workspace-1': [
          {
            id: 'page-1',
            workspaceId: 'workspace-1',
            worktreeId: 'wt',
            url: 'https://example.com/',
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
    if (result.ok) {
      const page = result.value.browserPagesByWorkspace?.['workspace-1']?.[0]
      expect(page?.id).toBe('page-1')
      expect(page?.remoteBrowserPageId).toBeUndefined()
      expect(page?.remoteBrowserPageClientHosted).toBeUndefined()
    }
  })
})
