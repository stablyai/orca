import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type {
  CrossMachineRecoveryApplyOp,
  RecoveryWorkspaceFragment
} from '../../../../shared/cross-machine-recovery-session-ops'
import { handleCrossMachineRecoveryApplyRequest } from './cross-machine-recovery-apply'
import { buildOwnedEditorFileId } from './editor/file-ids/editor-file-ids'
import { createStoreSessionMockApi } from './store-session-test-harness'
import {
  createTestStore,
  makeLayout,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  TEST_REPO
} from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const WT = 'repo1::/repo1/wt'
const PANE_KEY = 'tab-new:3c2b1a00-0000-4000-8000-000000000001'

const record: SleepingAgentSessionRecord = {
  paneKey: PANE_KEY,
  tabId: 'tab-new',
  worktreeId: WT,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'session-1' },
  prompt: '',
  state: 'done',
  capturedAt: 1,
  updatedAt: 1,
  launchConfig: { agentArgs: '', agentEnv: {} },
  origin: 'recovery',
  restoreOnTabOpenOnly: false,
  recovery: { importKey: 'key', sourcePaneKey: 'src-tab:src-leaf' }
}

function fragment(): RecoveryWorkspaceFragment {
  return {
    worktreeId: WT,
    terminalTabs: [makeTab({ id: 'tab-new', worktreeId: WT, ptyId: null })],
    terminalLayoutsByTabId: { 'tab-new': makeLayout() },
    unifiedTabs: [makeUnifiedTab({ id: 'tab-new', worktreeId: WT, groupId: 'group-new' })],
    tabGroups: [
      makeTabGroup({
        id: 'group-new',
        worktreeId: WT,
        activeTabId: 'tab-new',
        tabOrder: ['tab-new']
      })
    ],
    tabGroupLayout: { type: 'leaf', groupId: 'group-new' },
    activeGroupId: 'group-new',
    openFiles: [
      {
        filePath: '/repo1/wt/src/a.ts',
        relativePath: 'src/a.ts',
        worktreeId: WT,
        language: 'typescript'
      }
    ],
    activeFileId: '/repo1/wt/src/a.ts',
    browserWorkspaces: [],
    browserPagesByWorkspace: {},
    activeBrowserTabId: null,
    activeTabType: 'terminal',
    activeTabId: 'tab-new'
  }
}

function importOp(): CrossMachineRecoveryApplyOp {
  return { kind: 'import', importKey: 'key', fragment: fragment(), records: [record] }
}

function setup() {
  const store = createTestStore()
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/repo1/wt' })] }
  })
  const session = {
    set: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined)
  }
  const api = {
    session: { ...window.api.session, ...session },
    crossMachineRecovery: window.api.crossMachineRecovery
  }
  const apply = (op: CrossMachineRecoveryApplyOp) =>
    handleCrossMachineRecoveryApplyRequest(store, api, { requestId: 'r1', op })
  return { store, session, apply }
}

describe('cross-machine recovery renderer apply', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('imports the fragment into an empty worktree and persists before replying', async () => {
    const { store, session, apply } = setup()
    const reply = await apply(importOp())

    expect(reply).toEqual({ requestId: 'r1', outcome: { ok: true, claimed: null } })
    const state = store.getState()
    expect(state.tabsByWorktree[WT]?.map((tab) => [tab.id, tab.ptyId])).toEqual([['tab-new', null]])
    expect(state.unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-new'])
    expect(state.groupsByWorktree[WT]?.map((group) => group.id)).toEqual(['group-new'])
    expect(state.activeGroupIdByWorktree[WT]).toBe('group-new')
    expect(state.openFiles.map((file) => [file.id, file.worktreeId])).toEqual([
      ['/repo1/wt/src/a.ts', WT]
    ])
    expect(state.activeFileIdByWorktree[WT]).toBe('/repo1/wt/src/a.ts')
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    expect(state.defaultTerminalTabsAppliedByWorktreeId[WT]).toBe(true)
    expect(state.recoveryImportKeyByWorktreeId[WT]).toBe('key')
    expect(session.set).toHaveBeenCalledTimes(1)
    const persisted = session.set.mock.calls[0][0]
    expect(persisted.recoveryImportKeyByWorktreeId).toEqual({ [WT]: 'key' })
    expect(persisted.sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    expect(persisted.tabsByWorktree[WT].map((tab: { id: string }) => tab.id)).toEqual(['tab-new'])
    expect(session.flush).toHaveBeenCalledTimes(1)
  })

  it('refreshes the local catalog before importing into a worktree the renderer has not listed', async () => {
    const { store, apply } = setup()
    store.setState({ worktreesByRepo: { repo1: [] } })
    const fetchWorktrees = vi
      .spyOn(store.getState(), 'fetchWorktrees')
      .mockImplementation(async () => {
        store.setState({
          worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/repo1/wt' })] }
        })
        return true
      })

    const reply = await apply(importOp())

    expect(fetchWorktrees).toHaveBeenCalledTimes(1)
    expect(fetchWorktrees).toHaveBeenCalledWith('repo1', { forceLocalOwner: true })
    expect(reply).toEqual({ requestId: 'r1', outcome: { ok: true, claimed: null } })
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-new'])
  })

  it('fails the import instead of dropping the layout when the worktree stays unknown', async () => {
    const { store, session, apply } = setup()
    store.setState({ worktreesByRepo: { repo1: [] } })
    vi.spyOn(store.getState(), 'fetchWorktrees').mockResolvedValue(true)

    const reply = await apply(importOp())

    expect(reply).toEqual({
      requestId: 'r1',
      error: `Recovery destination ${WT} is not a known local worktree`
    })
    expect(store.getState().tabsByWorktree[WT]).toBeUndefined()
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(session.set).not.toHaveBeenCalled()
  })

  it('refuses a worktree that already has live tabs without writing', async () => {
    const { store, session, apply } = setup()
    store.setState({ tabsByWorktree: { [WT]: [makeTab({ id: 'existing', worktreeId: WT })] } })

    const reply = await apply(importOp())

    expect(reply).toEqual({
      requestId: 'r1',
      outcome: { ok: false, code: 'recovery_destination_not_empty' }
    })
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['existing'])
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(session.set).not.toHaveBeenCalled()
  })

  it('reports an import whose layout already landed without applying it twice', async () => {
    const { store, session, apply } = setup()
    await apply(importOp())
    const landed = store.getState()

    const reply = await apply(importOp())

    expect(reply).toEqual({
      requestId: 'r1',
      outcome: { ok: true, claimed: null, alreadyApplied: true }
    })
    expect(store.getState().tabsByWorktree[WT]).toEqual(landed.tabsByWorktree[WT])
    expect(store.getState().openFiles).toEqual(landed.openFiles)
    expect(session.set.mock.calls.at(-1)?.[0].recoveryImportKeyByWorktreeId).toEqual({
      [WT]: 'key'
    })
  })

  it('claims a recovery record exactly once and restores it', async () => {
    const { store, session, apply } = setup()
    store.setState({ sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record } })
    const claim: CrossMachineRecoveryApplyOp = {
      kind: 'claim-record',
      worktreeId: WT,
      binding: { agent: record.agent, ...record.providerSession }
    }

    expect(await apply(claim)).toEqual({ requestId: 'r1', outcome: { ok: true, claimed: record } })
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(await apply(claim)).toEqual({ requestId: 'r1', outcome: { ok: true, claimed: null } })

    await apply({ kind: 'restore-record', record })
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    expect(session.flush).toHaveBeenCalledTimes(3)
  })

  it('restores a claimed record when persisting the claim fails', async () => {
    const { store, session, apply } = setup()
    store.setState({ sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record } })
    session.set.mockRejectedValueOnce(new Error('disk full'))

    const reply = await apply({
      kind: 'claim-record',
      worktreeId: WT,
      binding: { agent: record.agent, ...record.providerSession }
    })

    expect(reply).toEqual({ requestId: 'r1', error: 'disk full' })
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
  })

  it('removes an import whose persistence fails', async () => {
    const { store, session, apply } = setup()
    session.flush.mockRejectedValueOnce(new Error('flush failed'))

    const reply = await apply(importOp())

    expect(reply).toEqual({ requestId: 'r1', error: 'flush failed' })
    const state = store.getState()
    expect(state.tabsByWorktree[WT] ?? []).toEqual([])
    expect(state.unifiedTabsByWorktree[WT] ?? []).toEqual([])
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(state.openFiles).toEqual([])
    expect(state.activeFileIdByWorktree[WT]).toBeUndefined()
    expect(state.defaultTerminalTabsAppliedByWorktreeId[WT]).toBeUndefined()
    expect(state.recoveryImportKeyByWorktreeId[WT]).toBeUndefined()
  })

  it('keeps tabs opened while a replayed import fails to persist', async () => {
    const { store, session, apply } = setup()
    await apply(importOp())
    session.flush.mockImplementationOnce(async () => {
      store.setState((s) => ({
        tabsByWorktree: {
          ...s.tabsByWorktree,
          [WT]: [...(s.tabsByWorktree[WT] ?? []), makeTab({ id: 'user-new', worktreeId: WT })]
        }
      }))
      throw new Error('disk full')
    })

    const reply = await apply(importOp())

    expect(reply).toEqual({ requestId: 'r1', error: 'disk full' })
    const state = store.getState()
    expect(state.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-new', 'user-new'])
    expect(state.unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-new'])
    expect(state.openFiles.map((file) => file.id)).toEqual(['/repo1/wt/src/a.ts'])
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    expect(state.recoveryImportKeyByWorktreeId[WT]).toBe('key')
  })

  it('binds an imported editor tab to its own file when another owner holds the path id', async () => {
    const { store, session, apply } = setup()
    const filePath = '/repo1/wt/src/a.ts'
    store.setState({
      openFiles: [
        makeOpenFile({
          id: filePath,
          worktreeId: 'repo2::/other',
          runtimeEnvironmentId: 'env-remote',
          relativePath: 'src/a.ts'
        })
      ]
    })
    const base = fragment()
    const op: CrossMachineRecoveryApplyOp = {
      kind: 'import',
      importKey: 'key',
      records: [record],
      fragment: {
        ...base,
        unifiedTabs: [
          ...base.unifiedTabs,
          makeUnifiedTab({
            id: filePath,
            entityId: filePath,
            worktreeId: WT,
            groupId: 'group-new',
            contentType: 'editor',
            label: 'a.ts'
          })
        ],
        tabGroups: [
          makeTabGroup({
            id: 'group-new',
            worktreeId: WT,
            activeTabId: filePath,
            tabOrder: ['tab-new', filePath],
            recentTabIds: ['tab-new', filePath]
          })
        ],
        activeTabType: 'editor',
        activeTabId: filePath
      }
    }

    const reply = await apply(op)

    expect(reply).toEqual({ requestId: 'r1', outcome: { ok: true, claimed: null } })
    const ownedId = buildOwnedEditorFileId(filePath, WT, undefined)
    const expectTabModel = (): void => {
      const state = store.getState()
      expect(state.openFiles.map((file) => [file.id, file.worktreeId])).toEqual([
        [filePath, 'repo2::/other'],
        [ownedId, WT]
      ])
      expect(state.unifiedTabsByWorktree[WT]?.map((tab) => [tab.id, tab.entityId])).toEqual([
        ['tab-new', 'tab-new'],
        [ownedId, ownedId]
      ])
      expect(state.groupsByWorktree[WT]).toEqual([
        expect.objectContaining({
          activeTabId: ownedId,
          tabOrder: ['tab-new', ownedId],
          recentTabIds: ['tab-new', ownedId]
        })
      ])
      expect(state.activeFileIdByWorktree[WT]).toBe(ownedId)
      expect(state.activeGroupIdByWorktree[WT]).toBe('group-new')
    }
    expectTabModel()
    store.getState().reconcileWorktreeTabModel(WT)
    expectTabModel()
    const persisted = session.set.mock.calls.at(-1)?.[0]
    expect(persisted.unifiedTabs[WT].map((tab: { entityId: string }) => tab.entityId)).toEqual([
      'tab-new',
      ownedId
    ])
    expect(persisted.activeFileIdByWorktree[WT]).toBe(ownedId)
  })

  it('does not treat a same-id runtime worktree as the local destination', async () => {
    const { store, session, apply } = setup()
    store.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WT,
            repoId: 'repo1',
            path: '/repo1/wt',
            hostId: 'runtime:env-1',
            runtimeOwnerEnvironmentId: 'env-1'
          })
        ]
      }
    })
    const fetchWorktrees = vi.spyOn(store.getState(), 'fetchWorktrees').mockResolvedValue(true)

    const reply = await apply(importOp())

    expect(fetchWorktrees).toHaveBeenCalledWith('repo1', { forceLocalOwner: true })
    expect(reply).toEqual({
      requestId: 'r1',
      error: `Recovery destination ${WT} is not a known local worktree`
    })
    expect(session.set).not.toHaveBeenCalled()
  })
})
