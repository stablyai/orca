// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Tab, TabContentType, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useOpenTabSearch } from './use-open-tab-search'

const initialAppState = useAppStore.getInitialState()

function makeWorktree(id: string, displayName: string): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/repo-1',
  displayName: 'octo/rocket',
  badgeColor: '#000000',
  addedAt: 0
}

function makeUnifiedTab({
  id,
  entityId,
  groupId,
  worktreeId = 'wt-1',
  contentType = 'terminal',
  label = ''
}: {
  id: string
  entityId: string
  groupId: string
  worktreeId?: string
  contentType?: TabContentType
  label?: string
}): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId,
    contentType,
    label,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeTerminalTab({
  id,
  title,
  worktreeId = 'wt-1',
  generatedTitle = null
}: {
  id: string
  title: string
  worktreeId?: string
  generatedTitle?: string | null
}): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title,
    generatedTitle,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeGroup(id: string, activeTabId: string | null, tabOrder: string[]): TabGroup {
  return { id, worktreeId: 'wt-1', activeTabId, tabOrder }
}

const browserWorkspace: BrowserWorkspace = {
  id: 'ws-1',
  worktreeId: 'wt-1',
  activePageId: 'page-1',
  pageIds: ['page-1'],
  url: 'https://example.com',
  title: 'zebra page',
  loading: false,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null,
  createdAt: 0
}

const browserPage: BrowserPage = {
  id: 'page-1',
  workspaceId: 'ws-1',
  worktreeId: 'wt-1',
  url: 'https://example.com/page',
  title: 'zebra page',
  loading: false,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null,
  createdAt: 0
}

// wt-1 spans two columns: group-1 shows tab-a, group-2 shows tab-c.
function seedStore(
  overrides: Partial<AppState> = {},
  executionHostId?: Tab['executionHostId']
): void {
  useAppStore.setState(
    {
      ...initialAppState,
      repos: [repo],
      worktreesByRepo: {
        'repo-1': [makeWorktree('wt-1', 'Aurora Workspace'), makeWorktree('wt-2', 'Nebula')]
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          makeUnifiedTab({ id: 'tab-a', entityId: 'term-a', groupId: 'group-1' }),
          makeUnifiedTab({ id: 'tab-b', entityId: 'term-b', groupId: 'group-1' }),
          makeUnifiedTab({ id: 'tab-c', entityId: 'term-c', groupId: 'group-2' }),
          makeUnifiedTab({
            id: 'tab-browser',
            entityId: 'ws-1',
            groupId: 'group-2',
            contentType: 'browser',
            label: 'zebra page'
          }),
          makeUnifiedTab({
            id: 'tab-sim',
            entityId: 'sim-1',
            groupId: 'group-2',
            contentType: 'simulator',
            label: 'zebra sim'
          })
        ].map((tab) => (executionHostId ? { ...tab, executionHostId } : tab)),
        'wt-2': [
          makeUnifiedTab({
            id: 'tab-d',
            entityId: 'term-d',
            groupId: 'group-3',
            worktreeId: 'wt-2'
          })
        ]
      },
      tabsByWorktree: {
        'wt-1': [
          makeTerminalTab({ id: 'term-a', title: 'zebra alpha' }),
          makeTerminalTab({ id: 'term-b', title: 'zebra beta' }),
          makeTerminalTab({ id: 'term-c', title: 'zebra gamma' })
        ],
        'wt-2': [makeTerminalTab({ id: 'term-d', title: 'zebra delta', worktreeId: 'wt-2' })]
      },
      groupsByWorktree: {
        'wt-1': [
          makeGroup('group-1', 'tab-a', ['tab-a', 'tab-b']),
          makeGroup('group-2', 'tab-c', ['tab-c', 'tab-browser', 'tab-sim'])
        ],
        'wt-2': [{ id: 'group-3', worktreeId: 'wt-2', activeTabId: 'tab-d', tabOrder: ['tab-d'] }]
      },
      browserTabsByWorktree: { 'wt-1': [browserWorkspace] },
      browserPagesByWorkspace: { 'ws-1': [browserPage] },
      activeGroupIdByWorktree: { 'wt-1': 'group-1', 'wt-2': 'group-3' },
      activeWorktreeId: 'wt-1',
      // Focus really sits on tab-a, so the engines mark it isCurrentTab.
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { 'wt-1': 'terminal' },
      activeTabId: 'term-a',
      activeTabIdByWorktree: { 'wt-1': 'term-a' },
      settings: {
        ...initialAppState.settings,
        tabAutoGenerateTitle: false
      } as AppState['settings'],
      ...overrides
    } as AppState,
    true
  )
}

function renderSearch(options: { enabled?: boolean; query?: string } = {}) {
  return renderHook(
    (props: { enabled: boolean; query: string }) =>
      useOpenTabSearch({ ...props, worktreeId: 'wt-1' }),
    {
      initialProps: {
        enabled: options.enabled ?? true,
        query: options.query ?? 'zebra'
      }
    }
  )
}

describe('useOpenTabSearch', () => {
  beforeEach(() => {
    seedStore()
  })

  it('returns no results while disabled', () => {
    const { result } = renderSearch({ enabled: false })

    expect(result.current.results).toEqual([])
  })

  it('returns only tabs from the requested worktree', () => {
    const { result } = renderSearch()

    expect(result.current.results.map((entry) => entry.title)).not.toContain('zebra delta')
    expect(result.current.results.every((entry) => entry.worktreeId === 'wt-1')).toBe(true)
  })

  it('keeps the active runtime host when worktree ids collide', () => {
    const runtimeHost = 'runtime:host-1' as const
    const localWorktree = { ...makeWorktree('wt-1', 'Local'), hostId: 'local' as const }
    const runtimeWorktree = {
      ...makeWorktree('wt-1', 'Runtime'),
      hostId: runtimeHost,
      path: '/runtime/wt-1'
    }
    seedStore(
      {
        activeWorkspaceExecutionHostId: runtimeHost,
        repos: [
          { ...repo, executionHostId: 'local', path: '/local/repo-1' },
          { ...repo, executionHostId: runtimeHost, path: '/runtime/repo-1' }
        ],
        worktreesByRepo: { 'repo-1': [localWorktree, runtimeWorktree] }
      },
      runtimeHost
    )

    const { result } = renderSearch()

    expect(result.current.results).not.toHaveLength(0)
    expect(result.current.results.every((entry) => entry.executionHostId === runtimeHost)).toBe(
      true
    )
  })

  it('resolves a hosted worktree when the active host is unknown', () => {
    const runtimeHost = 'runtime:host-1' as const
    const runtimeWorktree = {
      ...makeWorktree('wt-1', 'Runtime'),
      hostId: runtimeHost,
      path: '/runtime/wt-1'
    }
    const localWorktree = { ...makeWorktree('wt-1', 'Local'), hostId: 'local' as const }
    seedStore(
      {
        activeWorkspaceExecutionHostId: null,
        repos: [
          { ...repo, executionHostId: runtimeHost, path: '/runtime/repo-1' },
          { ...repo, executionHostId: 'local', path: '/local/repo-1' }
        ],
        worktreesByRepo: { 'repo-1': [runtimeWorktree, localWorktree] }
      },
      runtimeHost
    )

    const { result } = renderSearch()

    expect(result.current.results).not.toHaveLength(0)
    expect(result.current.results.every((entry) => entry.executionHostId === runtimeHost)).toBe(
      true
    )
  })

  it('returns tabs for a remote-only worktree when the active host is unknown', () => {
    const sshHost = 'ssh:remote-1' as const
    const remoteWorktree = {
      ...makeWorktree('wt-1', 'Remote'),
      hostId: sshHost,
      path: '/remote/wt-1'
    }
    seedStore({
      activeWorkspaceExecutionHostId: null,
      repos: [{ ...repo, executionHostId: sshHost, path: '/remote/repo-1' }],
      worktreesByRepo: { 'repo-1': [remoteWorktree] }
    })

    const { result } = renderSearch()

    expect(result.current.results).not.toHaveLength(0)
    expect(result.current.results.every((entry) => entry.executionHostId === sshHost)).toBe(true)
  })

  it('falls back to the active host when neither the worktree nor a repo names one', () => {
    const runtimeHost = 'runtime:env-1' as const
    seedStore({
      activeWorkspaceExecutionHostId: runtimeHost,
      repos: [],
      worktreesByRepo: {
        'repo-1': [{ ...makeWorktree('wt-1', 'Runtime'), runtimeOwnerEnvironmentId: 'env-1' }]
      }
    })

    const { result } = renderSearch()

    expect(result.current.results).not.toHaveLength(0)
    expect(result.current.results.every((entry) => entry.executionHostId === runtimeHost)).toBe(
      true
    )
  })

  it('does not rebuild results for agent-status heartbeats while open', () => {
    const { result } = renderSearch()
    const initialResults = result.current.results
    const state = useAppStore.getState()

    act(() => {
      useAppStore.setState({ agentStatusByPaneKey: { ...state.agentStatusByPaneKey } })
    })

    expect(result.current.results).toBe(initialResults)
  })

  it('includes tabs from every column of the worktree, not just the focused one', () => {
    const { result } = renderSearch()

    // zebra alpha is the focused tab and still listed, ranked first by the
    // engine's current-tab bonus, the way Cmd+J lists the tab you are on.
    expect(result.current.results.map((entry) => entry.title)).toEqual([
      'zebra alpha',
      'zebra beta',
      'zebra gamma',
      'zebra page'
    ])
  })

  it('reflects tab changes while open', () => {
    const { result } = renderSearch({ query: 'epsilon' })
    expect(result.current.results).toEqual([])

    const state = useAppStore.getState()
    act(() => {
      useAppStore.setState({
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          'wt-1': [
            ...(state.unifiedTabsByWorktree['wt-1'] ?? []),
            makeUnifiedTab({ id: 'tab-e', entityId: 'term-e', groupId: 'group-1' })
          ]
        },
        tabsByWorktree: {
          ...state.tabsByWorktree,
          'wt-1': [
            ...(state.tabsByWorktree['wt-1'] ?? []),
            makeTerminalTab({ id: 'term-e', title: 'zebra epsilon' })
          ]
        },
        groupsByWorktree: {
          ...state.groupsByWorktree,
          'wt-1': [
            makeGroup('group-1', 'tab-a', ['tab-a', 'tab-b', 'tab-e']),
            makeGroup('group-2', 'tab-c', ['tab-c', 'tab-browser', 'tab-sim'])
          ]
        }
      })
    })

    expect(result.current.results.map((entry) => entry.title)).toEqual(['zebra epsilon'])
  })

  it('reflects the generated-titles setting in matched titles', () => {
    seedStore({
      tabsByWorktree: {
        'wt-1': [makeTerminalTab({ id: 'term-a', title: '', generatedTitle: 'zebra generated' })]
      },
      settings: {
        ...initialAppState.settings,
        tabAutoGenerateTitle: true
      } as AppState['settings']
    })

    const { result } = renderSearch({ query: 'generated' })
    expect(result.current.results.map((entry) => entry.title)).toEqual(['zebra generated'])

    seedStore({
      tabsByWorktree: {
        'wt-1': [makeTerminalTab({ id: 'term-a', title: '', generatedTitle: 'zebra generated' })]
      }
    })
    const disabled = renderSearch({ query: 'generated' })
    expect(disabled.result.current.results).toEqual([])
  })
})
