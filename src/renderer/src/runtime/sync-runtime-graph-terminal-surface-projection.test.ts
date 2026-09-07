import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots, registerRuntimeTerminalTab } from './sync-runtime-graph'
import { makeAgentStatusEntry, makeState } from './sync-runtime-graph-test-harness'
import { getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '../store/types'

function registerMobileTestSurface(args: {
  tabId: string
  leafIds: string[]
  activeLeafId: string
  launchAgentLeafId: string | null
}): {
  unregister: () => void
  setTopology: (leafIds: string[], activeLeafId: string) => void
} {
  let leafIds = [...args.leafIds]
  let activeLeafId = args.activeLeafId
  const paneIdByLeafId = new Map(args.leafIds.map((leafId, index) => [leafId, index + 1]))
  const manager = {
    getPanes: () => leafIds.map((leafId) => ({ id: paneIdByLeafId.get(leafId)!, leafId })),
    getActivePane: () => {
      const paneId = paneIdByLeafId.get(activeLeafId)
      return !paneId || !leafIds.includes(activeLeafId)
        ? null
        : { id: paneId, leafId: activeLeafId }
    },
    getLeafId: (paneId: number) =>
      leafIds.find((leafId) => paneIdByLeafId.get(leafId) === paneId) ?? null,
    getNumericIdForLeaf: (leafId: string) =>
      leafIds.includes(leafId) ? (paneIdByLeafId.get(leafId) ?? null) : null
  }
  return {
    unregister: registerRuntimeTerminalTab({
      tabId: args.tabId,
      worktreeId: 'wt-1',
      getManager: () => manager as never,
      getContainer: () => null,
      getPtyIdForPane: (paneId) => `pty-${paneId}`,
      getTabWideAgentHintLeafId: () => args.launchAgentLeafId
    }),
    setTopology: (nextLeafIds, nextActiveLeafId) => {
      leafIds = [...nextLeafIds]
      activeLeafId = nextActiveLeafId
    }
  }
}

describe('buildMobileSessionTabSnapshots', () => {
  it('publishes the native-chat launch draft on terminal surface tabs', () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const state = makeState({
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Terminal 1', launchAgent: 'claude' }]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-1' }
        }
      } as unknown as AppState['terminalLayoutsByTabId'],
      nativeChatLaunchDraftByTabId: {
        'term-1': {
          tabId: 'term-1',
          agent: 'claude',
          text: 'https://github.com/o/r/issues/12',
          createdAt: 1
        }
      }
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'term-1',
        launchDraft: 'https://github.com/o/r/issues/12',
        launchDraftCreatedAt: 1
      })
    ])
  })

  it('retracts a launch draft as soon as mobile resolves it', () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const state = makeState({
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Terminal 1', launchAgent: 'claude' }]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-1' }
        }
      } as unknown as AppState['terminalLayoutsByTabId'],
      nativeChatLaunchDraftByTabId: {
        'term-1': {
          tabId: 'term-1',
          agent: 'claude',
          text: 'issue link',
          createdAt: 1,
          resolved: true
        }
      }
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs[0]).not.toHaveProperty('launchDraft')
  })

  it('withholds a launch draft seeded for a different agent than the tab runs', () => {
    // The seed is keyed by tab id, which survives an agent switch. Desktop's
    // consumer declines on mismatch; publishing anyway would prefill the new
    // agent's mobile chat with the previous agent's link.
    const leafId = '11111111-1111-4111-8111-111111111111'
    const state = makeState({
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Terminal 1', launchAgent: 'codex' }]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-1' }
        }
      } as unknown as AppState['terminalLayoutsByTabId'],
      nativeChatLaunchDraftByTabId: {
        'term-1': {
          tabId: 'term-1',
          agent: 'claude',
          text: 'https://github.com/o/r/issues/12',
          createdAt: 1
        }
      }
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs[0]).not.toHaveProperty('launchDraft')
  })

  it('keeps agent identity and launch context off a plain sibling leaf', () => {
    const agentLeafId = '11111111-1111-4111-8111-111111111111'
    const shellLeafId = '22222222-2222-4222-8222-222222222222'
    const surface = registerMobileTestSurface({
      tabId: 'term-1',
      leafIds: [agentLeafId, shellLeafId],
      activeLeafId: shellLeafId,
      launchAgentLeafId: agentLeafId
    })
    try {
      const state = makeState({
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'term-1',
              title: 'Codex working',
              customTitle: null,
              launchAgent: 'codex',
              generatedTitle: 'Inspect the image',
              aiVaultTitle: {
                agent: 'codex',
                sessionId: 'session-1',
                title: '[Image #1] Inspect the image'
              }
            }
          ]
        } as unknown as AppState['tabsByWorktree'],
        terminalLayoutsByTabId: {
          'term-1': {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: agentLeafId },
              second: { type: 'leaf', leafId: shellLeafId }
            },
            activeLeafId: shellLeafId,
            expandedLeafId: null
          }
        } as AppState['terminalLayoutsByTabId'],
        runtimePaneTitlesByTabId: {
          'term-1': { 1: 'Codex working', 2: 'zsh' }
        },
        agentStatusByPaneKey: {
          [`term-1:${agentLeafId}`]: makeAgentStatusEntry({
            paneKey: `term-1:${agentLeafId}`,
            agentType: 'codex',
            terminalTitle: 'Codex working'
          })
        },
        nativeChatLaunchDraftByTabId: {
          'term-1': {
            tabId: 'term-1',
            agent: 'codex',
            text: 'inspect this image',
            createdAt: 1
          }
        }
      })

      const tabs = buildMobileSessionTabSnapshots(state)[0]?.tabs ?? []
      const agentLeaf = tabs.find((tab) => tab.type === 'terminal' && tab.leafId === agentLeafId)
      const shellLeaf = tabs.find((tab) => tab.type === 'terminal' && tab.leafId === shellLeafId)

      expect(agentLeaf).toMatchObject({
        title: 'Codex working',
        agentStatus: { agentType: 'codex' }
      })
      expect(shellLeaf).toMatchObject({ title: 'zsh' })
      expect(shellLeaf).not.toHaveProperty('agentStatus')
      expect(shellLeaf).not.toHaveProperty('launchAgent')
      expect(shellLeaf).not.toHaveProperty('launchDraft')
      expect(shellLeaf).not.toHaveProperty('quickCommandLabel')
    } finally {
      surface.unregister()
    }
  })

  it('re-engages tab-wide launch context after the owning leaf becomes the sole leaf', () => {
    const agentLeafId = '33333333-3333-4333-8333-333333333333'
    const shellLeafId = '44444444-4444-4444-8444-444444444444'
    const surface = registerMobileTestSurface({
      tabId: 'term-collapse',
      leafIds: [agentLeafId, shellLeafId],
      activeLeafId: shellLeafId,
      launchAgentLeafId: agentLeafId
    })
    try {
      surface.setTopology([agentLeafId], agentLeafId)
      const state = makeState({
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'term-collapse',
              title: 'Codex ready',
              customTitle: null,
              launchAgent: 'codex',
              aiVaultTitle: {
                agent: 'codex',
                sessionId: 'session-collapse',
                title: 'Inspect mobile routing'
              }
            }
          ]
        } as unknown as AppState['tabsByWorktree'],
        terminalLayoutsByTabId: {
          'term-collapse': {
            root: { type: 'leaf', leafId: agentLeafId },
            activeLeafId: agentLeafId,
            expandedLeafId: null
          }
        } as AppState['terminalLayoutsByTabId'],
        nativeChatLaunchDraftByTabId: {
          'term-collapse': {
            tabId: 'term-collapse',
            agent: 'codex',
            text: 'inspect mobile routing',
            createdAt: 2
          }
        },
        runtimePaneTitlesByTabId: { 'term-collapse': { 1: 'Codex live title' } }
      })

      expect(buildMobileSessionTabSnapshots(state)[0]?.tabs).toEqual([
        expect.objectContaining({
          leafId: agentLeafId,
          title: 'Inspect mobile routing',
          launchAgent: 'codex',
          launchDraft: 'inspect mobile routing'
        })
      ])
    } finally {
      surface.unregister()
    }
  })

  it('keeps split-leaf ownership stable across reorder and active-leaf changes', () => {
    const agentLeafId = '55555555-5555-4555-8555-555555555555'
    const shellLeafId = '66666666-6666-4666-8666-666666666666'
    const surface = registerMobileTestSurface({
      tabId: 'term-reorder',
      leafIds: [agentLeafId, shellLeafId],
      activeLeafId: agentLeafId,
      launchAgentLeafId: agentLeafId
    })
    try {
      surface.setTopology([shellLeafId, agentLeafId], shellLeafId)
      const state = makeState({
        activeTabId: 'term-reorder',
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'term-reorder',
              title: '[Image #1] Wrong scope',
              customTitle: null,
              launchAgent: 'codex'
            }
          ]
        } as unknown as AppState['tabsByWorktree'],
        terminalLayoutsByTabId: {
          'term-reorder': {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: shellLeafId },
              second: { type: 'leaf', leafId: agentLeafId }
            },
            activeLeafId: shellLeafId,
            expandedLeafId: null
          }
        } as AppState['terminalLayoutsByTabId'],
        runtimePaneTitlesByTabId: {
          'term-reorder': { 1: 'Codex working', 2: 'fish' }
        },
        agentStatusByPaneKey: {
          [`term-reorder:${agentLeafId}`]: makeAgentStatusEntry({
            paneKey: `term-reorder:${agentLeafId}`,
            terminalTitle: 'Codex working'
          })
        }
      })

      const tabs = buildMobileSessionTabSnapshots(state)[0]?.tabs ?? []
      expect(tabs).toMatchObject([
        { leafId: shellLeafId, title: 'fish', isActive: true },
        { leafId: agentLeafId, title: 'Codex working', isActive: false }
      ])
      expect(tabs[0]).not.toHaveProperty('agentStatus')
      expect(tabs[1]).toHaveProperty('agentStatus.agentType', 'codex')
    } finally {
      surface.unregister()
    }
  })

  it('preserves single-leaf tab-wide identity while provider status is arriving', () => {
    const leafId = '77777777-7777-4777-8777-777777777777'
    const state = makeState({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'term-pending-status',
            title: 'Codex ready',
            customTitle: null,
            launchAgent: 'codex',
            generatedTitle: 'Prepare the release'
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-pending-status': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null
        }
      } as AppState['terminalLayoutsByTabId'],
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
      agentStatusByPaneKey: {}
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs).toEqual([
      expect.objectContaining({
        leafId,
        title: 'Prepare the release',
        launchAgent: 'codex'
      })
    ])
  })

  it('publishes terminal pane agent status', () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = `term-1:${leafId}`
    const state = makeState({
      tabBarOrderByWorktree: { 'wt-1': ['term-1'] },
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'codex [working]', customTitle: null, ptyId: 'pty-1' }]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-1' }
        }
      } as AppState['terminalLayoutsByTabId'],
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'fix parity',
          updatedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000,
          agentType: 'codex',
          paneKey,
          terminalTitle: 'codex [working]',
          stateHistory: []
        }
      }
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs).toMatchObject([
      {
        type: 'terminal',
        id: `term-1::${leafId}`,
        agentStatus: {
          state: 'working',
          prompt: 'fix parity',
          agentType: 'codex',
          paneKey
        }
      }
    ])
  })

  it('does not publish terminal pane agent status for the Claude agents screen behind a custom title', () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = `term-1:${leafId}`
    const state = makeState({
      tabBarOrderByWorktree: { 'wt-1': ['term-1'] },
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'claude agents', customTitle: 'Pinned', ptyId: 'pty-1' }]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-1' }
        }
      } as AppState['terminalLayoutsByTabId'],
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'stale task',
          updatedAt: 1_700_000_000_000,
          stateStartedAt: 1_699_999_999_000,
          agentType: 'claude',
          paneKey,
          terminalTitle: 'claude working',
          stateHistory: []
        }
      }
    })

    const [tab] = buildMobileSessionTabSnapshots(state)[0]?.tabs ?? []

    expect(tab).toMatchObject({
      type: 'terminal',
      id: `term-1::${leafId}`,
      title: 'Pinned'
    })
    expect(tab).not.toHaveProperty('agentStatus')
  })

  it('publishes generated terminal titles to mobile snapshots only when enabled', () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const base = makeState({
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: false },
      tabBarOrderByWorktree: { 'wt-1': ['term-1'] },
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'term-1',
            title: 'Codex working',
            generatedTitle: 'Fix remote tabs',
            customTitle: null,
            ptyId: 'pty-1'
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-1' }
        }
      } as AppState['terminalLayoutsByTabId']
    })

    expect(buildMobileSessionTabSnapshots(base)[0]?.tabs[0]).toMatchObject({
      type: 'terminal',
      title: 'Codex working'
    })
    expect(
      buildMobileSessionTabSnapshots({
        ...base,
        settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true }
      })[0]?.tabs[0]
    ).toMatchObject({
      type: 'terminal',
      title: 'Fix remote tabs'
    })
  })

  it('publishes quick command labels to mobile snapshots before generated titles', () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const state = makeState({
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
      tabBarOrderByWorktree: { 'wt-1': ['term-1'] },
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'term-1',
            title: 'pnpm test',
            quickCommandLabel: 'Run tests',
            generatedTitle: 'Generated title',
            customTitle: null,
            ptyId: 'pty-1'
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-1' }
        }
      } as AppState['terminalLayoutsByTabId']
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs[0]).toMatchObject({
      type: 'terminal',
      title: 'Run tests',
      quickCommandLabel: 'Run tests'
    })
  })

  it('publishes the desktop-resolved terminal theme for mobile terminal tabs', () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const state = makeState({
      settings: {
        ...getDefaultSettings('/tmp'),
        theme: 'light',
        terminalUseSeparateLightTheme: true,
        terminalColorOverrides: {
          background: '#f8f8f8',
          foreground: '#101010',
          cursor: '#202020'
        },
        terminalBackgroundOpacity: 0.8,
        terminalCursorOpacity: 0.5
      },
      tabBarOrderByWorktree: { 'wt-1': ['term-1'] },
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Terminal', customTitle: null, ptyId: 'pty-1' }]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-1' }
        }
      } as AppState['terminalLayoutsByTabId']
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs).toMatchObject([
      {
        type: 'terminal',
        terminalTheme: {
          mode: 'light',
          theme: {
            background: 'rgba(248, 248, 248, 0.8)',
            foreground: '#101010',
            cursor: 'rgba(32, 32, 32, 0.5)'
          }
        }
      }
    ])
  })

  it('uses the explicit system appearance for mobile terminal theme snapshots', () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const state = makeState({
      settings: {
        ...getDefaultSettings('/tmp'),
        theme: 'system',
        terminalUseSeparateLightTheme: true
      },
      tabBarOrderByWorktree: { 'wt-1': ['term-1'] },
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Terminal', customTitle: null, ptyId: 'pty-1' }]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-1' }
        }
      } as AppState['terminalLayoutsByTabId']
    })

    expect(buildMobileSessionTabSnapshots(state, false)[0]?.tabs).toMatchObject([
      {
        type: 'terminal',
        terminalTheme: { mode: 'light' }
      }
    ])
    expect(buildMobileSessionTabSnapshots(state, true)[0]?.tabs).toMatchObject([
      {
        type: 'terminal',
        terminalTheme: { mode: 'dark' }
      }
    ])
  })
})
