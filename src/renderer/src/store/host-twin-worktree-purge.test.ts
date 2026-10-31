import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getWorktreeVisitKey } from '@/lib/worktree-visit-recency'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { resetHostTwinModuleStores } from './host-twin-state-projection.test-fixture'
import {
  createHostTwinFixture,
  TWIN_RUNTIME_ENV,
  type HostTwinFixture
} from './host-twin.test-fixture'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

let current: HostTwinFixture | null = null

beforeEach(() => {
  vi.stubGlobal('window', { api: { pty: { kill: vi.fn() } } })
})

afterEach(() => {
  if (current) {
    resetHostTwinModuleStores(current)
  }
  current = null
  vi.unstubAllGlobals()
})

function twin(kind: Parameters<typeof createHostTwinFixture>[0] = 'local+ssh'): HostTwinFixture {
  const fixture = createHostTwinFixture(kind)
  current = fixture
  const key = fixture.workspaceKey
  fixture.store.setState({
    gitStatusByWorktree: { [key]: [] },
    activeWorktreeId: key,
    activeWorkspaceExecutionHostId: fixture.remote.hostId,
    lastVisitedAtByWorktreeId: {
      [getWorktreeVisitKey(key, fixture.local.hostId)]: 1,
      [getWorktreeVisitKey(key, fixture.remote.hostId)]: 2
    }
  })
  return fixture
}

function keepOnlyRemoteRow(fixture: HostTwinFixture): void {
  fixture.store.setState((s) => ({
    worktreesByRepo: {
      [fixture.projectId]: (s.worktreesByRepo[fixture.projectId] ?? []).filter(
        (row) => row.hostId === fixture.remote.hostId
      )
    }
  }))
}

describe('purgeWorktreeTerminalState with a surviving twin', () => {
  it("purges only the target host's attributable state", () => {
    const f = twin()
    const key = f.workspaceKey

    const previous = {
      paneKey: f.remote.paneKey,
      state: 'done' as const,
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      terminalResumeEligible: false as const
    }
    f.store.setState({ agentStatusByPaneKey: { [f.remote.paneKey]: previous } })
    const accepted = vi.fn()
    const dispose = f.store.getState().subscribeAgentStatusChanges(accepted)
    f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.remote })])
    expect(accepted).toHaveBeenCalledExactlyOnceWith([
      { paneKey: f.remote.paneKey, previous, current: undefined }
    ])
    dispose()

    const s = f.store.getState()
    expect(s.tabsByWorktree[key]?.map((tab) => tab.id)).toEqual([
      f.local.terminalTabId,
      f.dormantTabId
    ])
    expect(s.ptyIdsByTabId[f.remote.terminalTabId]).toBeUndefined()
    expect(s.terminalLayoutsByTabId[f.remote.terminalTabId]).toBeUndefined()
    expect(s.ptyIdsByTabId[f.local.terminalTabId]).toEqual([f.local.ptyId])
    expect(s.unifiedTabsByWorktree[key]?.map((tab) => tab.id)).toEqual([
      f.local.terminalTabId,
      f.local.fileId,
      f.dormantTabId
    ])
    expect(s.groupsByWorktree[key]?.[0]?.tabOrder).toEqual([
      f.local.terminalTabId,
      f.local.fileId,
      f.dormantTabId
    ])
    expect(s.openFiles.map((file) => file.id)).toEqual([f.local.fileId])
    expect(Object.keys(s.editorDrafts)).toEqual([f.local.fileId])
    expect(Object.keys(s.sleepingAgentSessionsByPaneKey)).toEqual([f.local.paneKey])
    // Shared buckets and raw-id module stores cannot name a host, so the twin keeps them.
    expect(s.gitStatusByWorktree[key]).toEqual([])
    expect(hasWorktreeSleepIntent(key)).toBe(true)
    expect(Object.keys(s.lastVisitedAtByWorktreeId)).toEqual([
      getWorktreeVisitKey(key, f.local.hostId)
    ])
    expect(s.activeWorktreeId).toBe(key)
    expect(s.activeWorkspaceExecutionHostId).toBe(f.local.hostId)
  })

  it('keeps PTY-keyed state for a purged PTY that a kept tab still binds', () => {
    const f = twin()
    const shared = f.remote.ptyId
    // A mixed-host split: the kept local tab also binds the purged copy's PTY.
    f.store.setState((s) => ({
      ptyIdsByTabId: { ...s.ptyIdsByTabId, [f.local.terminalTabId]: [f.local.ptyId, shared] },
      suppressedPtyExitIds: { [shared]: true },
      pendingPaneAccountRestarts: { [shared]: 'codex' }
    }))

    f.store
      .getState()
      .purgeWorktreeTerminalState([hostWorktreeTarget({ id: f.workspaceKey, ...f.remote })])

    const s = f.store.getState()
    expect(s.ptyIdsByTabId[f.local.terminalTabId]).toEqual([f.local.ptyId, shared])
    expect(s.suppressedPtyExitIds).toEqual({ [shared]: true })
    expect(s.pendingPaneAccountRestarts).toEqual({ [shared]: 'codex' })
  })

  it('collapses a split the purged copy emptied, handing selection to the survivor', () => {
    const f = twin()
    const key = f.workspaceKey
    f.store.setState((s) => {
      const [group] = s.groupsByWorktree[key] ?? []
      if (!group) {
        throw new Error('fixture has no tab group')
      }
      const remoteIds = [f.remote.terminalTabId, f.remote.fileId]
      return {
        groupsByWorktree: {
          [key]: [
            { ...group, tabOrder: group.tabOrder.filter((id) => !remoteIds.includes(id)) },
            { ...group, id: 'remote-group', tabOrder: remoteIds, activeTabId: remoteIds[0] }
          ]
        },
        unifiedTabsByWorktree: {
          [key]: (s.unifiedTabsByWorktree[key] ?? []).map((tab) =>
            remoteIds.includes(tab.id) ? { ...tab, groupId: 'remote-group' } : tab
          )
        },
        layoutByWorktree: {
          [key]: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: group.id },
            second: { type: 'leaf', groupId: 'remote-group' }
          }
        },
        activeGroupIdByWorktree: { [key]: 'remote-group' }
      }
    })

    f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.remote })])

    const s = f.store.getState()
    const survivingGroupIds = (s.groupsByWorktree[key] ?? []).map((group) => group.id)
    expect(survivingGroupIds).not.toContain('remote-group')
    expect(survivingGroupIds).toHaveLength(1)
    expect(s.layoutByWorktree[key]).not.toEqual(expect.objectContaining({ type: 'split' }))
    expect(s.activeGroupIdByWorktree[key]).toBe(survivingGroupIds[0])
  })

  it('keeps an untouched active group when it collapses a split the purge emptied', () => {
    const f = twin()
    const key = f.workspaceKey
    const remoteIds = [f.remote.terminalTabId, f.remote.fileId]
    f.store.setState((s) => {
      const [group] = s.groupsByWorktree[key] ?? []
      if (!group) {
        throw new Error('fixture has no tab group')
      }
      const localIds = group.tabOrder.filter((id) => !remoteIds.includes(id))
      return {
        groupsByWorktree: {
          [key]: [
            { ...group, id: 'a', tabOrder: localIds.slice(0, 1), activeTabId: localIds[0] },
            { ...group, id: 'b', tabOrder: localIds.slice(1), activeTabId: localIds[1] },
            { ...group, id: 'c', tabOrder: remoteIds, activeTabId: remoteIds[0] }
          ]
        },
        layoutByWorktree: {
          [key]: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'a' },
            second: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', groupId: 'b' },
              second: { type: 'leaf', groupId: 'c' }
            }
          }
        },
        activeGroupIdByWorktree: { [key]: 'a' }
      }
    })

    f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.remote })])

    const s = f.store.getState()
    expect((s.groupsByWorktree[key] ?? []).map((group) => group.id)).toEqual(['a', 'b'])
    expect(s.activeGroupIdByWorktree[key]).toBe('a')
  })

  it('keeps the runtime twin when the local copy is purged', () => {
    const f = twin('local+runtime')
    const key = f.workspaceKey

    f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.local })])

    const s = f.store.getState()
    expect(s.tabsByWorktree[key]?.map((tab) => tab.id)).toEqual([
      f.remote.terminalTabId,
      f.dormantTabId
    ])
    expect(s.openFiles.map((file) => file.id)).toEqual([f.remote.fileId])
  })

  it('purges everything when no other host publishes the id', () => {
    const f = twin()
    const key = f.workspaceKey
    keepOnlyRemoteRow(f)

    f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.remote })])

    const s = f.store.getState()
    expect(s.tabsByWorktree[key]).toBeUndefined()
    expect(s.openFiles).toEqual([])
    expect(s.gitStatusByWorktree[key]).toBeUndefined()
    expect(hasWorktreeSleepIntent(key)).toBe(false)
    // Recency stays host-scoped, as before.
    expect(Object.keys(s.lastVisitedAtByWorktreeId)).toEqual([
      getWorktreeVisitKey(key, f.local.hostId)
    ])
  })

  it('purges everything when every publishing host is targeted', () => {
    const f = twin()
    const key = f.workspaceKey

    f.store
      .getState()
      .purgeWorktreeTerminalState([
        hostWorktreeTarget({ id: key, ...f.remote }),
        hostWorktreeTarget({ id: key, ...f.local })
      ])

    expect(f.store.getState().tabsByWorktree[key]).toBeUndefined()
    expect(f.store.getState().gitStatusByWorktree[key]).toBeUndefined()
  })

  it('keeps the raw-id purge reaching both twins', () => {
    const f = twin()
    const key = f.workspaceKey

    f.store.getState().purgeWorktreeTerminalState([key])

    const s = f.store.getState()
    expect(s.tabsByWorktree[key]).toBeUndefined()
    expect(s.openFiles).toEqual([])
    expect(s.lastVisitedAtByWorktreeId).toEqual({})
  })

  it("drops a tabless sleeping record that names the purged SSH host, not the twin's", () => {
    const f = twin()
    const key = f.workspaceKey
    const record = f.store.getState().sleepingAgentSessionsByPaneKey[f.remote.paneKey]
    f.store.setState((s) => ({
      sleepingAgentSessionsByPaneKey: {
        ...s.sleepingAgentSessionsByPaneKey,
        'gone-ssh:leaf': { ...record, paneKey: 'gone-ssh:leaf' },
        'gone-local:leaf': { ...record, paneKey: 'gone-local:leaf', connectionId: null }
      }
    }))

    f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.remote })])

    expect(Object.keys(f.store.getState().sleepingAgentSessionsByPaneKey).sort()).toEqual(
      ['gone-local:leaf', f.local.paneKey].sort()
    )
  })

  it('selects a surviving tab when the purged terminal was active', () => {
    const f = twin()
    const key = f.workspaceKey
    f.store.setState((s) => ({
      activeTabId: f.remote.terminalTabId,
      activeTabType: 'terminal',
      groupsByWorktree: {
        [key]: (s.groupsByWorktree[key] ?? []).map((group) => ({
          ...group,
          activeTabId: f.remote.terminalTabId,
          recentTabIds: [f.local.fileId, f.remote.terminalTabId]
        }))
      }
    }))

    f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.remote })])

    const s = f.store.getState()
    expect(s.groupsByWorktree[key]?.[0]?.activeTabId).toBe(f.local.fileId)
    expect(s.activeTabType).toBe('editor')
    expect(s.activeFileId).toBe(f.local.fileId)
  })

  it("attributes a paired runtime's purge to the SSH copy it reaches", () => {
    const f = twin()
    const key = f.workspaceKey
    const runtimeHostId = `runtime:${TWIN_RUNTIME_ENV}` as const
    f.store.setState((s) => ({
      worktreesByRepo: {
        [f.projectId]: (s.worktreesByRepo[f.projectId] ?? []).map((row) =>
          row.hostId === f.remote.hostId
            ? { ...row, runtimeOwnerEnvironmentId: TWIN_RUNTIME_ENV }
            : row
        )
      },
      lastVisitedAtByWorktreeId: {
        ...s.lastVisitedAtByWorktreeId,
        [getWorktreeVisitKey(key, runtimeHostId)]: 3
      }
    }))

    f.store
      .getState()
      .purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, hostId: runtimeHostId })])

    const s = f.store.getState()
    expect(s.tabsByWorktree[key]?.map((tab) => tab.id)).toEqual([
      f.local.terminalTabId,
      f.dormantTabId
    ])
    expect(s.openFiles.map((file) => file.id)).toEqual([f.local.fileId])
    // Recency written under either identity of the purged copy goes; the twin's stays.
    expect(Object.keys(s.lastVisitedAtByWorktreeId)).toEqual([
      getWorktreeVisitKey(key, f.local.hostId)
    ])
  })

  it('keeps an untouched legacy selection when another host is purged', () => {
    const f = twin()
    const key = f.workspaceKey
    f.store.setState({
      activeWorkspaceExecutionHostId: f.local.hostId,
      activeTabId: f.local.terminalTabId,
      activeTabType: 'terminal',
      activeFileIdByWorktree: { [key]: f.local.fileId },
      // A legacy workspace: no tab groups, so derivation prefers a remembered editor.
      groupsByWorktree: {}
    })

    f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.remote })])

    expect(f.store.getState().activeTabId).toBe(f.local.terminalTabId)
    expect(f.store.getState().activeTabType).toBe('terminal')
  })

  it.each([
    ['drops', 'remote-source.md', 'local-source.md', false],
    ['keeps', 'shared-source.md', 'shared-source.md', true]
  ] as const)(
    "%s a purged preview's source state by whether a surviving file still uses it",
    (_verb, remoteSource, localSource, kept) => {
      const f = twin()
      const key = f.workspaceKey
      f.store.setState((s) => ({
        openFiles: s.openFiles.map((file) => ({
          ...file,
          markdownPreviewSourceFileId: file.id === f.remote.fileId ? remoteSource : localSource
        })),
        editorDrafts: { ...s.editorDrafts, [remoteSource]: 'source draft' }
      }))

      f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.remote })])

      expect(remoteSource in f.store.getState().editorDrafts).toBe(kept)
      expect(f.store.getState().editorDrafts[f.local.fileId]).toBeDefined()
    }
  )
})
