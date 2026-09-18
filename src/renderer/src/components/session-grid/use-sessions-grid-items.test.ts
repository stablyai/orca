// @vitest-environment happy-dom
import { getDefaultSettings } from '../../../../shared/constants'
import {
  makeRepo as makeGridTestRepo,
  makeWorktree as makeGridTestWorktree
} from '@/components/worktree-jump-palette-test-fixtures'
import { makeTerminalTab as makeGridTestTerminalTab } from '@/store/slices/worktrees-slice-test-fixtures'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { useSessionsGridItems } from './use-sessions-grid-items'
import { i18n } from '@/i18n/i18n'
import { livePtyIdsFor } from './session-grid-test-live-ptys'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'

const initialState = useAppStore.getInitialState()
beforeEach(() => useAppStore.setState(initialState, true))
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

function seedWorkspaceSessions(): void {
  const repos: Repo[] = [
    makeGridTestRepo({ id: 'repo-1', displayName: 'sytio', path: '/code/sytio' }),
    makeGridTestRepo({ id: 'repo-2', displayName: 'orca', path: '/code/orca' })
  ]

  const worktreesByRepo: Record<string, Worktree[]> = {
    'repo-1': [
      makeGridTestWorktree('grid-fixture', '', {
        path: '',
        id: 'wt-1',
        displayName: 'sytio',
        branch: 'solidez/base'
      })
    ],
    'repo-2': [
      makeGridTestWorktree('grid-fixture', '', {
        path: '',
        id: 'wt-2',
        displayName: 'orca-feature',
        branch: 'feat/grid'
      })
    ]
  }

  const tabsByWorktree: Record<string, TerminalTab[]> = {
    'wt-1': [
      makeGridTestTerminalTab({
        customTitle: null,
        color: null,
        sortOrder: 0,
        id: 'tab-1',
        ptyId: 'pty-1',
        worktreeId: 'wt-1',
        title: 'Session',
        createdAt: 100
      }),
      makeGridTestTerminalTab({
        customTitle: null,
        color: null,
        sortOrder: 0,
        id: 'tab-2',
        ptyId: 'pty-2',
        worktreeId: 'wt-1',
        title: 'Base de conocimiento contrato 21%',
        createdAt: 200
      })
    ],
    'wt-2': [
      makeGridTestTerminalTab({
        customTitle: null,
        color: null,
        sortOrder: 0,
        id: 'tab-3',
        ptyId: 'pty-3',
        worktreeId: 'wt-2',
        title: 'Term 3',
        createdAt: 300
      })
    ]
  }

  useAppStore.setState({
    repos,
    worktreesByRepo,
    tabsByWorktree,
    ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
    sessionsGridFilter: 'all'
  })
}

describe('useSessionsGridItems', () => {
  it('refreshes translated filter labels when the language changes without session activity', async () => {
    await i18n.changeLanguage('en')
    const { result, unmount } = renderHook(() => useSessionsGridItems())
    expect(result.current.filterOptions[0].label).toBe('All workspaces')
    try {
      await act(async () => {
        await i18n.changeLanguage('es')
      })
      expect(result.current.filterOptions[0].label).toBe('Todos los espacios')
    } finally {
      unmount()
      await i18n.changeLanguage('en')
    }
  })
  it('collects sessions from multiple worktrees and builds filter options', () => {
    seedWorkspaceSessions()

    const { result } = renderHook(() => useSessionsGridItems())

    expect(result.current.allItems).toHaveLength(3)
    expect(result.current.items).toHaveLength(3)
    // Chronological order: oldest first, new sessions append at end
    expect(result.current.items[0].tabId).toBe('tab-1')
    expect(result.current.items[0].branch).toBe('solidez/base')
    expect(result.current.items[0].repoName).toBe('sytio')

    expect(result.current.items[1].tabId).toBe('tab-2')
    expect(result.current.items[1].contextPercent).toBe(undefined)

    expect(result.current.items[2].tabId).toBe('tab-3')
    expect(result.current.items[2].branch).toBe('feat/grid')
    expect(result.current.items[2].repoName).toBe('orca')

    expect(result.current.filterOptions).toEqual([
      { id: 'all', label: 'All workspaces', count: 3 },
      { id: 'wt-1', label: 'sytio', count: 2 },
      { id: 'wt-2', label: 'orca / orca-feature', count: 1 }
    ])
  })

  it('filters items when activeFilter is set to a specific worktree', () => {
    seedWorkspaceSessions()
    useAppStore.setState({
      sessionsGridFilter: 'wt-1'
    })

    const { result } = renderHook(() => useSessionsGridItems())
    expect(result.current.items).toHaveLength(2)
    expect(result.current.items.every((i) => i.worktreeId === 'wt-1')).toBe(true)
  })
  it('previews the active split leaf and never a pty the store does not list as live', () => {
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      'wt-1': [
        // Split tab: `tab.ptyId` names the first pane, the layout's active leaf the one in use.
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 'tab-split',
          ptyId: 'pty-a',
          worktreeId: 'wt-1',
          title: 'Split',
          createdAt: 1
        }),
        // Parked after a restart: the layout still names a pty that no longer exists.
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 'tab-parked',
          ptyId: 'pty-old',
          worktreeId: 'wt-1',
          title: 'Parked',
          createdAt: 2
        })
      ]
    }
    const leaf = '11111111-1111-4111-8111-111111111111'
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree,
      terminalLayoutsByTabId: {
        'tab-split': {
          root: null,
          expandedLeafId: null,
          activeLeafId: leaf,
          ptyIdsByLeafId: { [leaf]: 'pty-b' }
        },
        'tab-parked': {
          root: null,
          expandedLeafId: null,
          activeLeafId: leaf,
          ptyIdsByLeafId: { [leaf]: 'pty-old' }
        }
      },
      ptyIdsByTabId: { 'tab-split': ['pty-a', 'pty-b'], 'tab-parked': [] },
      sessionsGridFilter: 'all',
      sessionsGridTabOrder: []
    })

    const { result } = renderHook(() => useSessionsGridItems())
    const byTab = new Map(result.current.items.map((item) => [item.tabId, item]))

    expect(byTab.get('tab-split')).toMatchObject({ ptyId: 'pty-b', paneKey: `tab-split:${leaf}` })
    expect(byTab.get('tab-parked')).toMatchObject({ ptyId: null, paneKey: null })
  })

  it('keys a live tab.ptyId on the leaf it is bound to, so an SSH pane still encodes keys for its host', () => {
    const leaf = '22222222-2222-4222-8222-222222222222'
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      'wt-1': [
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 'tab-a',
          ptyId: 'pty-a',
          worktreeId: 'wt-1',
          title: 'A',
          createdAt: 1
        }),
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 'tab-b',
          ptyId: 'pty-b',
          worktreeId: 'wt-1',
          title: 'B',
          createdAt: 2
        })
      ]
    }
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree,
      terminalLayoutsByTabId: {
        // No active leaf yet (layout still hydrating), but the pty is bound to a leaf.
        'tab-a': {
          root: null,
          expandedLeafId: null,
          activeLeafId: null,
          ptyIdsByLeafId: { [leaf]: 'pty-a' }
        }
      },
      ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
      sessionsGridFilter: 'all',
      sessionsGridTabOrder: []
    })

    const { result } = renderHook(() => useSessionsGridItems())
    const byTab = new Map(result.current.items.map((item) => [item.tabId, item]))

    expect(byTab.get('tab-a')).toMatchObject({ ptyId: 'pty-a', paneKey: `tab-a:${leaf}` })
    // No layout at all: the pty is live but nothing binds it to a leaf.
    expect(byTab.get('tab-b')).toMatchObject({ ptyId: 'pty-b', paneKey: null })
  })

  it('reads the dot from hook state, so a permission prompt shows before the title changes', () => {
    const leaf = '33333333-3333-4333-8333-333333333333'
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      'wt-1': [
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 'tab-h',
          ptyId: 'pty-h',
          worktreeId: 'wt-1',
          title: 'claude',
          launchAgent: 'claude',
          createdAt: 1
        })
      ]
    }
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree,
      terminalLayoutsByTabId: {
        'tab-h': {
          root: null,
          expandedLeafId: null,
          activeLeafId: leaf,
          ptyIdsByLeafId: { [leaf]: 'pty-h' }
        }
      },
      ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
      agentStatusByPaneKey: {
        [`tab-h:${leaf}`]: {
          stateHistory: [],
          state: 'blocked',
          agentType: 'claude',
          paneKey: `tab-h:${leaf}`,
          prompt: '',
          updatedAt: Date.now(),
          stateStartedAt: Date.now()
        }
      },
      agentStatusEpoch: 1,
      sessionsGridFilter: 'all',
      sessionsGridTabOrder: []
    })

    const { result } = renderHook(() => useSessionsGridItems())
    expect(result.current.items[0]?.dotState).toBe('permission')
  })

  it('titles a card the way the tab bar does: quick-command label over the live title', () => {
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      'wt-1': [
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 'tab-q',
          ptyId: 'pty-q',
          worktreeId: 'wt-1',
          title: 'zsh',
          quickCommandLabel: 'Run tests',
          createdAt: 1
        }),
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 'tab-g',
          ptyId: 'pty-g',
          worktreeId: 'wt-1',
          title: '',
          generatedTitle: 'Fix the flaky spec',
          defaultTitle: 'Terminal 2',
          createdAt: 2
        })
      ]
    }
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree,
      terminalLayoutsByTabId: {},
      agentStatusByPaneKey: {},
      ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: false },
      sessionsGridFilter: 'all',
      sessionsGridTabOrder: []
    })

    const { result } = renderHook(() => useSessionsGridItems())
    expect(result.current.items.map((i) => i.title)).toEqual(['Run tests', 'Terminal 2'])

    act(() => {
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true }
      })
    })
    expect(result.current.items[1]?.title).toBe('Fix the flaky spec')
  })

  it('keeps the worktree catalog identity across a title tick', () => {
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      'wt-1': [
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: 'wt-1',
          title: 'A',
          createdAt: 1
        })
      ]
    }
    useAppStore.setState({
      repos: [makeGridTestRepo({ id: 'repo-1', displayName: 'repo', path: '/r' })],
      worktreesByRepo: {
        'repo-1': [
          makeGridTestWorktree('grid-fixture', '', {
            branch: '',
            path: '',
            id: 'wt-1',
            displayName: 'repo'
          })
        ]
      },
      tabsByWorktree,
      ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
      sessionsGridFilter: 'all',
      sessionsGridTabOrder: []
    })

    const { result } = renderHook(() => useSessionsGridItems())
    const catalogBefore = result.current.worktreeCatalog
    const itemsBefore = result.current.items
    expect(catalogBefore.byWorktreeId.get('wt-1')?.label).toBe('repo')

    act(() => {
      useAppStore.setState({
        tabsByWorktree: {
          'wt-1': [{ ...tabsByWorktree['wt-1']![0]!, title: 'B' }]
        }
      })
    })
    expect(result.current.items).not.toBe(itemsBefore)
    expect(result.current.worktreeCatalog).toBe(catalogBefore)
  })
  it('falls back to ALL when the persisted filter names a workspace that no longer exists', () => {
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      'wt-1': [
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: 'wt-1',
          title: 'A',
          createdAt: 1
        })
      ]
    }
    useAppStore.setState({
      repos: [makeGridTestRepo({ id: 'repo-1', displayName: 'repo', path: '/r' })],
      worktreesByRepo: {
        'repo-1': [
          makeGridTestWorktree('grid-fixture', '', {
            branch: '',
            path: '',
            id: 'wt-1',
            displayName: 'repo'
          })
        ]
      },
      tabsByWorktree,
      ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
      sessionsGridFilter: 'wt-deleted',
      sessionsGridTabOrder: []
    })

    const { result } = renderHook(() => useSessionsGridItems())

    expect(result.current.activeFilter).toBe('all')
    expect(result.current.items.map((i) => i.tabId)).toEqual(['tab-1'])
  })

  it('keeps a live workspace filter with a zero-count chip once its last session closes', () => {
    useAppStore.setState({
      repos: [makeGridTestRepo({ id: 'repo-1', displayName: 'repo', path: '/r' })],
      worktreesByRepo: {
        'repo-1': [
          makeGridTestWorktree('grid-fixture', '', {
            branch: '',
            path: '',
            id: 'wt-1',
            displayName: 'repo'
          }),
          makeGridTestWorktree('grid-fixture', '', {
            branch: '',
            path: '',
            id: 'wt-2',
            displayName: 'quiet'
          })
        ]
      },
      tabsByWorktree: {
        'wt-1': [
          makeGridTestTerminalTab({
            customTitle: null,
            color: null,
            sortOrder: 0,
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'wt-1',
            title: 'A',
            createdAt: 1
          })
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      sessionsGridFilter: 'wt-2',
      sessionsGridTabOrder: []
    })

    const { result } = renderHook(() => useSessionsGridItems())

    expect(result.current.activeFilter).toBe('wt-2')
    expect(result.current.items).toEqual([])
    expect(result.current.filterOptions).toContainEqual({
      id: 'wt-2',
      label: 'repo / quiet',
      count: 0
    })
    // The unfiltered list is what a drag reorders, so it must still be complete.
    expect(result.current.allItems.map((i) => i.tabId)).toEqual(['tab-1'])
  })

  it('hands back the same item object for a card an agent-status burst did not touch', () => {
    const leaf = '44444444-4444-4444-8444-444444444444'
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      'wt-1': [
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 'tab-q',
          ptyId: 'pty-q',
          worktreeId: 'wt-1',
          title: 'Quiet',
          createdAt: 1
        }),
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 'tab-n',
          ptyId: 'pty-n',
          worktreeId: 'wt-1',
          title: 'Noisy',
          createdAt: 2
        })
      ]
    }
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree,
      terminalLayoutsByTabId: {
        'tab-n': {
          root: null,
          expandedLeafId: null,
          activeLeafId: leaf,
          ptyIdsByLeafId: { [leaf]: 'pty-n' }
        }
      },
      ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
      agentStatusByPaneKey: {},
      agentStatusEpoch: 0,
      sessionsGridFilter: 'all',
      sessionsGridTabOrder: []
    })

    const { result } = renderHook(() => useSessionsGridItems())
    const quietBefore = result.current.allItems.find((i) => i.tabId === 'tab-q')
    expect(quietBefore).toBeDefined()

    act(() => {
      useAppStore.setState({
        agentStatusByPaneKey: {
          [`tab-n:${leaf}`]: {
            stateHistory: [],
            state: 'working',
            agentType: 'claude',
            paneKey: `tab-n:${leaf}`,
            prompt: '',
            updatedAt: Date.now(),
            stateStartedAt: Date.now()
          }
        },
        agentStatusEpoch: 1
      })
    })

    expect(result.current.allItems.find((i) => i.tabId === 'tab-n')?.dotState).toBe('working')
    expect(result.current.allItems.find((i) => i.tabId === 'tab-q')).toBe(quietBefore)
  })

  it('reads a context percentage only when the title says so', () => {
    const tabsByWorktree: Record<string, TerminalTab[]> = {
      'wt-1': [
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 't1',
          ptyId: 'p1',
          worktreeId: 'wt-1',
          title: 'Claude — context left 21%',
          createdAt: 1
        }),
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 't2',
          ptyId: 'p2',
          worktreeId: 'wt-1',
          title: '87% context used',
          createdAt: 2
        }),
        makeGridTestTerminalTab({
          customTitle: null,
          color: null,
          sortOrder: 0,
          id: 't3',
          ptyId: 'p3',
          worktreeId: 'wt-1',
          title: 'Deploy at 50% rollout',
          createdAt: 3
        })
      ]
    }
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree,
      ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
      sessionsGridFilter: 'all',
      sessionsGridTabOrder: []
    })
    const { result } = renderHook(() => useSessionsGridItems())
    expect(result.current.allItems.map((i) => i.contextPercent)).toEqual([21, 87, undefined])
  })
})
