import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import type { TerminalLayoutSnapshot, TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { folderWorkspaceKey } from './workspace-scope'
import { adoptOrphanedWorkspaceSessionPartition } from './workspace-session-partition-adoption'

const WORKTREE_ID = 'repo-1::/srv/wt'
const FOLDER_KEY = folderWorkspaceKey('folder-1')
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function tab(id: string, worktreeId = WORKTREE_ID, ptyId: string | null = null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

function layout(ptyId: string | null): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf' as const, leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: ptyId ? { [LEAF_ID]: ptyId } : undefined
  }
}

describe('adoptOrphanedWorkspaceSessionPartition', () => {
  it.each([1000, 2000])(
    'indexes %i equivalent workspaces without per-workspace global layout scans',
    (workspaceCount) => {
      let globalLayoutScans = 0
      const makeEquivalentSession = (): WorkspaceSessionState => {
        const tabsByWorktree: WorkspaceSessionState['tabsByWorktree'] = {}
        const terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId'] = {}
        for (let index = 0; index < workspaceCount; index += 1) {
          const workspaceKey = `repo-${index}::/srv/worktree-${index}`
          const tabId = `tab-${index}`
          tabsByWorktree[workspaceKey] = [tab(tabId, workspaceKey, null)]
          terminalLayoutsByTabId[tabId] = layout(null)
        }
        return session({
          tabsByWorktree,
          terminalLayoutsByTabId: new Proxy(terminalLayoutsByTabId, {
            ownKeys(target) {
              globalLayoutScans += 1
              return Reflect.ownKeys(target)
            }
          })
        })
      }

      const base = makeEquivalentSession()
      const source = makeEquivalentSession()
      const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

      expect(adoption.ambiguousWorktreeIds).toEqual([])
      expect(adoption.reconciledWorktreeIds).toHaveLength(workspaceCount)
      expect(globalLayoutScans).toBe(3)
    },
    20_000
  )

  it.each([
    ['git worktrees', 'repo-a::/srv/a', 'repo-b::/srv/b'],
    ['folder workspaces', folderWorkspaceKey('folder-a'), folderWorkspaceKey('folder-b')]
  ])('fails closed when %s reuse one tab identity', (_kind, baseKey, sourceKey) => {
    const tabId = 'duplicate-tab'
    const paneKey = `${tabId}:${LEAF_ID}`
    const base = session({
      tabsByWorktree: { [baseKey]: [tab(tabId, baseKey, 'local-pty')] },
      terminalLayoutsByTabId: { [tabId]: layout('local-pty') },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'local-incarnation' },
      remoteSessionIdsByTabId: { [tabId]: 'local-session' }
    })
    const source = session({
      tabsByWorktree: { [sourceKey]: [tab(tabId, sourceKey, 'ssh:one@@remote-pty')] },
      terminalLayoutsByTabId: { [tabId]: layout('ssh:one@@remote-pty') },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'remote-incarnation' },
      remoteSessionIdsByTabId: { [tabId]: 'ssh:one@@remote-session' },
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId,
          worktreeId: sourceKey,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'remote-provider-session' },
          prompt: 'remote',
          state: 'working',
          capturedAt: 2,
          updatedAt: 2
        }
      }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    expect(new Set(adoption.ambiguousWorktreeIds)).toEqual(new Set([baseKey, sourceKey]))
    expect(adoption.reconciledWorktreeIds).toEqual([])
    expect(adoption.sourceAuthoritativePaneKeys).toEqual([])
    expect(adoption.session.tabsByWorktree[baseKey]?.[0]?.ptyId).toBe('local-pty')
    expect(adoption.session.tabsByWorktree[sourceKey]).toBeUndefined()
    expect(adoption.session.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      'local-pty'
    )
    expect(adoption.session.terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe('local-incarnation')
    expect(adoption.session.remoteSessionIdsByTabId?.[tabId]).toBe('local-session')
    expect(adoption.session.sleepingAgentSessionsByPaneKey?.[paneKey]).toBeUndefined()
  })

  it('adopts complete folder-only state without a repository entry', () => {
    const source = session({
      activeWorkspaceKey: FOLDER_KEY,
      activeWorktreeId: FOLDER_KEY,
      activeTabId: 'tab-1',
      tabsByWorktree: { [FOLDER_KEY]: [tab('tab-1', FOLDER_KEY, 'ssh:one@@pty-1')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@pty-1') },
      openFilesByWorktree: {
        [FOLDER_KEY]: [
          {
            filePath: '/srv/folder/a.ts',
            relativePath: 'a.ts',
            worktreeId: FOLDER_KEY,
            language: 'typescript'
          }
        ]
      },
      activeFileIdByWorktree: { [FOLDER_KEY]: '/srv/folder/a.ts' },
      tabGroups: {
        [FOLDER_KEY]: [
          { id: 'group-1', worktreeId: FOLDER_KEY, activeTabId: 'tab-1', tabOrder: ['tab-1'] }
        ]
      },
      tabGroupLayouts: { [FOLDER_KEY]: { type: 'leaf', groupId: 'group-1' } },
      activeGroupIdByWorktree: { [FOLDER_KEY]: 'group-1' },
      activeTabIdByWorktree: { [FOLDER_KEY]: 'tab-1' },
      lastVisitedAtByWorktreeId: { [FOLDER_KEY]: 42 },
      defaultTerminalTabsAppliedByWorktreeId: { [FOLDER_KEY]: true }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(session({}), source)

    expect(adoption.reconciledWorktreeIds).toEqual([FOLDER_KEY])
    expect(adoption.session.tabsByWorktree[FOLDER_KEY]?.[0]?.ptyId).toBe('ssh:one@@pty-1')
    expect(adoption.session.activeWorkspaceKey).toBe(FOLDER_KEY)
    expect(adoption.session.activeWorktreeId).toBe(FOLDER_KEY)
    expect(adoption.session.openFilesByWorktree?.[FOLDER_KEY]?.[0]?.relativePath).toBe('a.ts')
    expect(adoption.session.tabGroups?.[FOLDER_KEY]?.[0]?.id).toBe('group-1')
    expect(adoption.session.tabGroupLayouts?.[FOLDER_KEY]).toEqual({
      type: 'leaf',
      groupId: 'group-1'
    })
    expect(adoption.session.lastVisitedAtByWorktreeId?.[FOLDER_KEY]).toBe(42)
  })

  it('uses a newer SSH topology revision as terminal membership authority', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('local-tab', WORKTREE_ID, 'local-pty')] },
      terminalLayoutsByTabId: { 'local-tab': layout('local-pty') },
      terminalTopologyRevisionByRepoId: { 'repo-1': 3 },
      tabGroups: {
        [WORKTREE_ID]: [
          {
            id: 'local-group',
            worktreeId: WORKTREE_ID,
            activeTabId: 'local-tab',
            tabOrder: ['local-tab']
          }
        ]
      }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@pty-1')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@pty-1') },
      terminalTopologyRevisionByRepoId: { 'repo-1': 4 },
      tabGroups: {
        [WORKTREE_ID]: [
          {
            id: 'ssh-group',
            worktreeId: WORKTREE_ID,
            activeTabId: 'tab-1',
            tabOrder: ['tab-1']
          }
        ]
      }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    expect(adoption.sourceAuthoritativeWorktreeIds).toEqual([WORKTREE_ID])
    expect(adoption.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'tab-1'
    ])
    expect(adoption.session.terminalLayoutsByTabId['local-tab']).toBeUndefined()
    expect(adoption.session.tabGroups?.[WORKTREE_ID]?.[0]?.id).toBe('ssh-group')
    expect(adoption.session.terminalTopologyRevisionByRepoId?.['repo-1']).toBe(4)
  })

  it('keeps newer local membership when the SSH topology revision is stale', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('local-tab')] },
      terminalTopologyRevisionByRepoId: { 'repo-1': 8 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('stale-tab')] },
      terminalTopologyRevisionByRepoId: { 'repo-1': 7 }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    expect(adoption.sourceAuthoritativeWorktreeIds).toEqual([])
    expect(adoption.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'local-tab'
    ])
  })

  it('uses SSH incarnation provenance for a newer binding and provider session', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@old')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@old') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-old' },
      remoteSessionIdsByTabId: { 'tab-1': 'ssh:one@@old' },
      terminalTopologyRevisionByRepoId: { 'repo-1': 1 },
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'provider-old' },
          prompt: 'old',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@new')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@new') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-new' },
      remoteSessionIdsByTabId: { 'tab-1': 'ssh:one@@new' },
      terminalTopologyRevisionByRepoId: { 'repo-1': 2 },
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'provider-new' },
          prompt: 'new',
          state: 'working',
          capturedAt: 2,
          updatedAt: 2
        }
      }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    expect(adoption.sourceAuthoritativePaneKeys).toEqual([PANE_KEY])
    expect(adoption.session.tabsByWorktree[WORKTREE_ID]?.[0]?.ptyId).toBe('ssh:one@@new')
    expect(adoption.session.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      'ssh:one@@new'
    )
    expect(adoption.session.terminalPtyIncarnationsByPaneKey?.[PANE_KEY]).toBe('inc-new')
    expect(adoption.session.remoteSessionIdsByTabId?.['tab-1']).toBe('ssh:one@@new')
    expect(adoption.session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.providerSession.id).toBe(
      'provider-new'
    )
  })

  it('moves an older provider record with its authoritative SSH incarnation', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@old')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@old') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-old' },
      terminalTopologyRevisionByRepoId: { 'repo-1': 4 },
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'provider-wrong' },
          prompt: 'wrong',
          state: 'working',
          capturedAt: 9,
          updatedAt: 9
        }
      }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@new')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@new') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-new' },
      terminalTopologyRevisionByRepoId: { 'repo-1': 5 },
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: {
          ...base.sleepingAgentSessionsByPaneKey![PANE_KEY],
          providerSession: { key: 'session_id', id: 'provider-new' },
          prompt: 'new',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    })

    const adopted = adoptOrphanedWorkspaceSessionPartition(base, source).session

    expect(adopted.terminalPtyIncarnationsByPaneKey?.[PANE_KEY]).toBe('inc-new')
    expect(adopted.sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.providerSession.id).toBe(
      'provider-new'
    )
  })

  it('preserves equal-revision pane bundles instead of combining their provenance', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@base')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@base') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-base' },
      terminalTopologyRevisionByRepoId: { 'repo-1': 3 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:two@@source')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:two@@source') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-source' },
      terminalTopologyRevisionByRepoId: { 'repo-1': 3 },
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'provider-source' },
          prompt: 'source',
          state: 'working',
          capturedAt: 10,
          updatedAt: 10
        }
      }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    expect(adoption.ambiguousWorktreeIds).toEqual([WORKTREE_ID])
    expect(adoption.session.tabsByWorktree[WORKTREE_ID]?.[0]?.ptyId).toBe('ssh:one@@base')
    expect(adoption.session.terminalPtyIncarnationsByPaneKey?.[PANE_KEY]).toBe('inc-base')
    expect(adoption.session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
  })

  it('keeps a local incarnation when the SSH binding revision is older', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@local')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@local') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-local' },
      terminalTopologyRevisionByRepoId: { 'repo-1': 5 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@stale')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@stale') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-stale' },
      terminalTopologyRevisionByRepoId: { 'repo-1': 4 }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    expect(adoption.sourceAuthoritativePaneKeys).toEqual([])
    expect(adoption.session.tabsByWorktree[WORKTREE_ID]?.[0]?.ptyId).toBe('ssh:one@@local')
    expect(adoption.session.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      'ssh:one@@local'
    )
    expect(adoption.session.terminalPtyIncarnationsByPaneKey?.[PANE_KEY]).toBe('inc-local')
  })

  it('does not let an old tombstone retire a newer SSH incarnation', () => {
    const base = session({
      terminalSurfaceTombstonesByPaneKey: {
        [PANE_KEY]: {
          worktreeId: WORKTREE_ID,
          parentTabId: 'tab-1',
          leafId: LEAF_ID,
          ptyId: 'ssh:one@@old',
          incarnationId: 'inc-old',
          retiredAt: 1
        }
      }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@new')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@new') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-new' }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    expect(adoption.session.tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    expect(adoption.session.terminalSurfaceTombstonesByPaneKey?.[PANE_KEY]).toBeUndefined()
  })

  it('is idempotent after provenance reconciliation', () => {
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@new')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@new') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-new' },
      terminalTopologyRevisionByRepoId: { 'repo-1': 2 }
    })
    const first = adoptOrphanedWorkspaceSessionPartition(session({}), source).session
    const second = adoptOrphanedWorkspaceSessionPartition(first, source).session

    expect(second).toEqual(first)
  })

  it('adopts pty-bound ssh panes over a revision-only base full of dormant tab rows', () => {
    const ghostLeaf = '22222222-2222-4222-8222-222222222222'
    const base = session({
      tabsByWorktree: {
        [WORKTREE_ID]: [tab('ghost-1'), tab('ghost-2')]
      },
      terminalLayoutsByTabId: {
        'ghost-1': { ...layout(null), root: { type: 'leaf', leafId: ghostLeaf } },
        'ghost-2': { ...layout(null), root: { type: 'leaf', leafId: ghostLeaf } }
      },
      terminalPtyIncarnationsByPaneKey: {
        [`ghost-1:${ghostLeaf}`]: 'inc-ghost-1',
        [`ghost-2:${ghostLeaf}`]: 'inc-ghost-2'
      },
      terminalTopologyRevisionByRepoId: { 'repo-1': 162 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@pty-34')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@pty-34') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-live' },
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: WORKTREE_ID,
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'session-live' },
          prompt: 'live',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    expect(adoption.sourceAuthoritativeWorktreeIds).toEqual([WORKTREE_ID])
    const adoptedIds = adoption.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)
    expect(adoptedIds).toContain('tab-1')
    expect(adoptedIds).toContain('ghost-1')
    expect(adoptedIds).toContain('ghost-2')
    const adoptedLive = adoption.session.tabsByWorktree[WORKTREE_ID]?.find(
      (entry) => entry.id === 'tab-1'
    )
    expect(adoptedLive?.ptyId).toBe('ssh:one@@pty-34')
    expect(adoption.session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.providerSession?.id).toBe(
      'session-live'
    )
    expect(adoption.session.terminalPtyIncarnationsByPaneKey?.[PANE_KEY]).toBe('inc-live')
  })

  it('keeps the winner tab list intact when the veto grafts a stray live pane', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('kept-dormant')] },
      terminalTopologyRevisionByRepoId: { 'repo-1': 162 }
    })
    const source = session({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          tab('kept-dormant'),
          tab('stray-dormant'),
          tab('tab-1', WORKTREE_ID, 'ssh:one@@pty-40')
        ]
      },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@pty-40') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-live' }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    // The graft is additive: the winner's own row survives, only the source's
    // pty-bound stray joins it, and dormant strays stay out of the adopted view.
    expect(adoption.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'kept-dormant',
      'tab-1'
    ])
    expect(adoption.session.terminalPtyIncarnationsByPaneKey?.[PANE_KEY]).toBe('inc-live')
  })

  it('does not resurrect a tombstoned pane through the pty-bound tiebreak', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('ghost-1')] },
      terminalTopologyRevisionByRepoId: { 'repo-1': 30 },
      terminalSurfaceTombstonesByPaneKey: {
        [PANE_KEY]: {
          worktreeId: WORKTREE_ID,
          parentTabId: 'tab-1',
          leafId: LEAF_ID,
          ptyId: 'ssh:one@@pty-5',
          incarnationId: 'inc-closed',
          retiredAt: 20
        }
      }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@pty-5')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@pty-5') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-closed' }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    expect(
      adoption.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id) ?? []
    ).not.toContain('tab-1')
  })

  it('merges a grafted key per pane: base row and layout survive, source bindings adopt', () => {
    const keptLeaf = '33333333-3333-4333-8333-333333333333'
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('kept-dormant')] },
      terminalLayoutsByTabId: {
        'kept-dormant': {
          root: { type: 'leaf', leafId: keptLeaf },
          activeLeafId: keptLeaf,
          expandedLeafId: null,
          titlesByLeafId: { [keptLeaf]: 'base-title' }
        }
      },
      terminalTopologyRevisionByRepoId: { 'repo-1': 162 }
    })
    const source = session({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          // Why the shared-id shape: the renderer wipes its persisted bindings on every
          // disconnect while the runtime partition keeps the live ones, so a base row
          // without a binding whose source copy is bound is the routine live topology.
          // The pane-level merge adopts the binding onto the kept row; the row itself
          // and leaf state the source does not bind stay base's.
          tab('kept-dormant', WORKTREE_ID, 'ssh:one@@pty-50'),
          tab('tab-1', WORKTREE_ID, 'ssh:one@@pty-51')
        ]
      },
      terminalLayoutsByTabId: {
        'kept-dormant': {
          root: { type: 'leaf', leafId: keptLeaf },
          activeLeafId: keptLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [keptLeaf]: 'ssh:one@@pty-50' }
        },
        'tab-1': layout('ssh:one@@pty-51')
      }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    expect(adoption.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual([
      'kept-dormant',
      'tab-1'
    ])
    const keptLayout = adoption.session.terminalLayoutsByTabId['kept-dormant']
    expect(keptLayout?.ptyIdsByLeafId?.[keptLeaf]).toBe('ssh:one@@pty-50')
    expect(keptLayout?.root).toEqual({ type: 'leaf', leafId: keptLeaf })
    expect(
      adoption.session.tabsByWorktree[WORKTREE_ID]?.find((entry) => entry.id === 'kept-dormant')
        ?.ptyId
    ).toBe('ssh:one@@pty-50')
  })

  it('keeps a base-kept tab leaf untouched when the source copy does not bind it', () => {
    const keptLeaf = '44444444-4444-4444-8444-444444444444'
    const baseLayout = {
      root: { type: 'leaf' as const, leafId: keptLeaf },
      activeLeafId: keptLeaf,
      expandedLeafId: null,
      titlesByLeafId: { [keptLeaf]: 'base-title' }
    }
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('kept-dormant')] },
      terminalLayoutsByTabId: { 'kept-dormant': baseLayout },
      terminalTopologyRevisionByRepoId: { 'repo-1': 162 }
    })
    const source = session({
      tabsByWorktree: {
        [WORKTREE_ID]: [tab('kept-dormant'), tab('tab-1', WORKTREE_ID, 'ssh:one@@pty-52')]
      },
      terminalLayoutsByTabId: {
        'kept-dormant': {
          root: { type: 'leaf', leafId: keptLeaf },
          activeLeafId: keptLeaf,
          expandedLeafId: null,
          titlesByLeafId: { [keptLeaf]: 'source-title-should-not-win' }
        },
        'tab-1': layout('ssh:one@@pty-52')
      }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    expect(
      adoption.session.terminalLayoutsByTabId['kept-dormant']?.titlesByLeafId?.[keptLeaf]
    ).toBe('base-title')
  })

  it('keeps a close-emptied worktree closed against a stale pty-bound partition copy', () => {
    const base = session({
      tabsByWorktree: { [WORKTREE_ID]: [] },
      terminalTopologyRevisionByRepoId: { 'repo-1': 163 }
    })
    const source = session({
      tabsByWorktree: { [WORKTREE_ID]: [tab('tab-1', WORKTREE_ID, 'ssh:one@@pty-dead')] },
      terminalLayoutsByTabId: { 'tab-1': layout('ssh:one@@pty-dead') },
      terminalPtyIncarnationsByPaneKey: { [PANE_KEY]: 'inc-stale' },
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: WORKTREE_ID,
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'session-stale' },
          prompt: 'stale',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    })

    const adoption = adoptOrphanedWorkspaceSessionPartition(base, source)

    expect(adoption.sourceAuthoritativeWorktreeIds).toEqual([])
    expect(adoption.session.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(adoption.session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
  })
})
