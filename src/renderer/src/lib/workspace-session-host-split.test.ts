import { describe, it, expect } from 'vitest'
import {
  splitWorkspaceSessionByHost,
  mergeWorkspaceSessionsFromHosts,
  type HostIdByWorktreeId
} from './workspace-session-host-split'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type {
  BrowserPage,
  Tab,
  TerminalLayoutSnapshot,
  TerminalTab,
  WorkspaceSessionState
} from '../../../shared/types'

const RUNTIME_A: ExecutionHostId = 'runtime:env-a'
const RUNTIME_B: ExecutionHostId = 'runtime:env-b'

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeUnifiedTab(id: string, worktreeId: string): Tab {
  return {
    id,
    entityId: id,
    groupId: `group-${worktreeId}`,
    worktreeId,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeLayout(): TerminalLayoutSnapshot {
  return { root: { type: 'leaf', leafId: 'leaf-1' }, activeLeafId: 'leaf-1', expandedLeafId: null }
}

function makeBrowserPage(id: string, workspaceId: string, worktreeId: string): BrowserPage {
  return {
    id,
    workspaceId,
    worktreeId,
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

/** worktree id convention in these tests: `<host>-wt-...`, except local ones. */
function ownerByPrefix(): HostIdByWorktreeId {
  return (worktreeId: string) => {
    if (worktreeId.startsWith('a-')) {
      return RUNTIME_A
    }
    if (worktreeId.startsWith('b-')) {
      return RUNTIME_B
    }
    return LOCAL_EXECUTION_HOST_ID
  }
}

describe('splitWorkspaceSessionByHost', () => {
  it('keeps global fields only on the local slice', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo-1',
      activeWorktreeId: 'local-wt',
      activeTabId: 'tab-1',
      browserUrlHistory: [
        { url: 'u', normalizedUrl: 'u', title: 't', lastVisitedAt: 1, visitCount: 1 }
      ],
      activeConnectionIdsAtShutdown: ['ssh-target']
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[LOCAL_EXECUTION_HOST_ID]?.activeRepoId).toBe('repo-1')
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.activeConnectionIdsAtShutdown).toEqual(['ssh-target'])
    // No runtime slice is created when nothing is worktree-owned by it.
    expect(slices[RUNTIME_A]).toBeUndefined()
  })

  it('routes worktree-keyed maps to their owner host', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        'local-wt': [makeTab('t-local', 'local-wt')],
        'a-wt': [makeTab('t-a', 'a-wt')],
        'b-wt': [makeTab('t-b', 'b-wt')]
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(Object.keys(slices[LOCAL_EXECUTION_HOST_ID]?.tabsByWorktree ?? {})).toEqual(['local-wt'])
    expect(Object.keys(slices[RUNTIME_A]?.tabsByWorktree ?? {})).toEqual(['a-wt'])
    expect(Object.keys(slices[RUNTIME_B]?.tabsByWorktree ?? {})).toEqual(['b-wt'])
  })

  it('routes tab-keyed maps via the owning tab worktree (legacy + unified)', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { 'a-wt': [makeTab('t-a', 'a-wt')] },
      unifiedTabs: { 'b-wt': [makeUnifiedTab('t-b', 'b-wt')] },
      terminalLayoutsByTabId: { 't-a': makeLayout(), 't-b': makeLayout() },
      remoteSessionIdsByTabId: { 't-a': 'sess-a', 't-b': 'sess-b' }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[RUNTIME_A]?.terminalLayoutsByTabId).toHaveProperty('t-a')
    expect(slices[RUNTIME_B]?.terminalLayoutsByTabId).toHaveProperty('t-b')
    expect(slices[RUNTIME_A]?.remoteSessionIdsByTabId).toEqual({ 't-a': 'sess-a' })
    expect(slices[RUNTIME_B]?.remoteSessionIdsByTabId).toEqual({ 't-b': 'sess-b' })
  })

  it('keeps orphan tab layouts (unknown worktree) in the local slice', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      terminalLayoutsByTabId: { orphan: makeLayout() }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[LOCAL_EXECUTION_HOST_ID]?.terminalLayoutsByTabId).toHaveProperty('orphan')
    expect(slices[RUNTIME_A]).toBeUndefined()
  })

  it('routes browser pages via their record worktreeId', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      browserPagesByWorkspace: {
        'ws-a': [makeBrowserPage('p-a', 'ws-a', 'a-wt')],
        'ws-local': [makeBrowserPage('p-local', 'ws-local', 'local-wt')]
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[RUNTIME_A]?.browserPagesByWorkspace).toHaveProperty('ws-a')
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.browserPagesByWorkspace).toHaveProperty('ws-local')
  })

  it('routes markdown frontmatter visibility via the open file worktree', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        'a-wt': [
          {
            filePath: '/a/file.md',
            relativePath: 'file.md',
            worktreeId: 'a-wt',
            language: 'markdown'
          }
        ]
      },
      markdownFrontmatterVisible: { '/a/file.md': true, '/unknown.md': true }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[RUNTIME_A]?.markdownFrontmatterVisible).toEqual({ '/a/file.md': true })
    // Unknown file id has no owner → stays local.
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.markdownFrontmatterVisible).toEqual({
      '/unknown.md': true
    })
  })

  it('partitions activeWorktreeIdsOnShutdown by owner', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeIdsOnShutdown: ['a-wt', 'b-wt', 'local-wt']
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[RUNTIME_A]?.activeWorktreeIdsOnShutdown).toEqual(['a-wt'])
    expect(slices[RUNTIME_B]?.activeWorktreeIdsOnShutdown).toEqual(['b-wt'])
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.activeWorktreeIdsOnShutdown).toEqual(['local-wt'])
  })

  it('routes sleeping agent records via their worktreeId', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: {
        'pane-a': {
          paneKey: 'pane-a',
          worktreeId: 'a-wt',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'x' },
          prompt: 'p',
          state: 'done',
          capturedAt: 1,
          updatedAt: 2
        }
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[RUNTIME_A]?.sleepingAgentSessionsByPaneKey).toHaveProperty('pane-a')
  })
})

describe('mergeWorkspaceSessionsFromHosts', () => {
  it('takes global fields from the local slice', () => {
    const merged = mergeWorkspaceSessionsFromHosts({
      [LOCAL_EXECUTION_HOST_ID]: {
        ...getDefaultWorkspaceSession(),
        activeRepoId: 'local-repo',
        activeWorktreeId: 'local-wt'
      },
      [RUNTIME_A]: {
        ...getDefaultWorkspaceSession(),
        // A non-local slice's global fields must lose to local.
        activeRepoId: 'runtime-repo',
        tabsByWorktree: { 'a-wt': [makeTab('t-a', 'a-wt')] }
      }
    })

    expect(merged.activeRepoId).toBe('local-repo')
    expect(merged.tabsByWorktree).toHaveProperty('a-wt')
  })

  it('falls back to a non-local slice for globals when local is absent', () => {
    const merged = mergeWorkspaceSessionsFromHosts({
      [RUNTIME_A]: {
        ...getDefaultWorkspaceSession(),
        activeRepoId: 'runtime-repo'
      }
    })
    expect(merged.activeRepoId).toBe('runtime-repo')
  })

  it('tolerates missing and empty slices', () => {
    const merged = mergeWorkspaceSessionsFromHosts({})
    expect(merged.tabsByWorktree).toBeUndefined()
    expect(() => mergeWorkspaceSessionsFromHosts({ [RUNTIME_A]: undefined })).not.toThrow()
  })
})

describe('split → merge round trip', () => {
  function roundTrip(state: WorkspaceSessionState): WorkspaceSessionState {
    return mergeWorkspaceSessionsFromHosts(splitWorkspaceSessionByHost(state, ownerByPrefix()))
  }

  it('preserves a representative multi-host state', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo-1',
      activeWorktreeId: 'a-wt',
      activeTabId: 't-a',
      tabsByWorktree: {
        'local-wt': [makeTab('t-local', 'local-wt')],
        'a-wt': [makeTab('t-a', 'a-wt')],
        'b-wt': [makeTab('t-b', 'b-wt')]
      },
      unifiedTabs: { 'b-wt': [makeUnifiedTab('t-b', 'b-wt')] },
      terminalLayoutsByTabId: { 't-local': makeLayout(), 't-a': makeLayout(), 't-b': makeLayout() },
      remoteSessionIdsByTabId: { 't-a': 'sess-a' },
      activeTabIdByWorktree: { 'local-wt': 't-local', 'a-wt': 't-a' },
      activeWorktreeIdsOnShutdown: ['a-wt', 'b-wt'],
      lastVisitedAtByWorktreeId: { 'a-wt': 10, 'local-wt': 5 },
      defaultTerminalTabsAppliedByWorktreeId: { 'a-wt': true },
      browserTabsByWorktree: {},
      browserPagesByWorkspace: {},
      browserUrlHistory: [
        { url: 'u', normalizedUrl: 'u', title: 't', lastVisitedAt: 1, visitCount: 1 }
      ]
    }

    expect(roundTrip(state)).toEqual(state)
  })

  it('preserves the default (empty) session', () => {
    const state = getDefaultWorkspaceSession()
    expect(roundTrip(state)).toEqual(state)
  })

  it('keeps orphan-owned entries in local and preserves them', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      terminalLayoutsByTabId: { orphan: makeLayout() },
      remoteSessionIdsByTabId: { orphan: 'sess' }
    }
    const result = roundTrip(state)
    expect(result.terminalLayoutsByTabId).toEqual(state.terminalLayoutsByTabId)
    expect(result.remoteSessionIdsByTabId).toEqual(state.remoteSessionIdsByTabId)
  })

  it('handles a host with only runtime-owned worktrees (empty local maps)', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { 'a-wt': [makeTab('t-a', 'a-wt')] },
      terminalLayoutsByTabId: { 't-a': makeLayout() }
    }
    expect(roundTrip(state)).toEqual(state)
  })
})
