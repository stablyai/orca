import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type {
  CrossMachineRecoveryApplyOp,
  RecoveryWorkspaceFragment
} from '../../../../shared/cross-machine-recovery-session-ops'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
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

const SECOND_PANE_KEY = 'tab-two:3c2b1a00-0000-4000-8000-000000000002'
const IMPORTED_FILE = '/repo1/wt/src/a.ts'

const secondRecord: SleepingAgentSessionRecord = {
  ...record,
  paneKey: SECOND_PANE_KEY,
  tabId: 'tab-two',
  providerSession: { key: 'session_id', id: 'session-2' },
  recovery: { importKey: 'key', sourcePaneKey: 'src-tab-two:src-leaf' }
}

function leaf(groupId: string): TabGroupLayoutNode {
  return { type: 'leaf', groupId }
}

function splitImportOp(
  tabGroupLayout: TabGroupLayoutNode,
  activeGroupId: string,
  groupIds: readonly string[] = ['group-new', 'group-file', 'group-two']
): CrossMachineRecoveryApplyOp {
  const base = fragment()
  const groupOf = (groupId: string): string => (groupIds.includes(groupId) ? groupId : 'group-new')
  const unifiedTabs = [
    makeUnifiedTab({ id: 'tab-new', worktreeId: WT, groupId: 'group-new' }),
    makeUnifiedTab({
      id: IMPORTED_FILE,
      entityId: IMPORTED_FILE,
      worktreeId: WT,
      groupId: groupOf('group-file'),
      contentType: 'editor',
      label: 'a.ts'
    }),
    makeUnifiedTab({ id: 'tab-two', worktreeId: WT, groupId: groupOf('group-two') })
  ]
  return {
    kind: 'import',
    importKey: 'key',
    records: [record, secondRecord],
    fragment: {
      ...base,
      terminalTabs: [...base.terminalTabs, makeTab({ id: 'tab-two', worktreeId: WT, ptyId: null })],
      terminalLayoutsByTabId: { ...base.terminalLayoutsByTabId, 'tab-two': makeLayout() },
      unifiedTabs,
      tabGroups: groupIds.map((id) => {
        const tabOrder = unifiedTabs.flatMap((tab) => (tab.groupId === id ? [tab.id] : []))
        return makeTabGroup({ id, worktreeId: WT, activeTabId: tabOrder[0] ?? null, tabOrder })
      }),
      tabGroupLayout,
      activeGroupId
    }
  }
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
    expect(session.set).toHaveBeenCalledTimes(2)
    expect(session.set.mock.calls[1][0].sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
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
    expect(session.set).toHaveBeenCalledTimes(2)
    const rewritten = session.set.mock.calls[1][0]
    expect(rewritten.recoveryImportKeyByWorktreeId ?? {}).toEqual({})
    expect(rewritten.sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
    expect(rewritten.tabsByWorktree[WT] ?? []).toEqual([])
    expect(session.flush).toHaveBeenCalledTimes(2)
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

  it('keeps tabs and unsaved files the user opened while a first import fails to persist', async () => {
    const { store, session, apply } = setup()
    let userTabId = ''
    let userFileId = ''
    session.flush.mockImplementationOnce(async () => {
      const state = store.getState()
      userTabId = state.createTab(WT).id
      userFileId = state.openFile({
        filePath: '/repo1/wt/user.ts',
        relativePath: 'user.ts',
        worktreeId: WT,
        language: 'typescript',
        mode: 'edit'
      })
      store.getState().setEditorDraft(userFileId, 'unsaved user data')
      store.getState().markFileDirty(userFileId, true)
      throw new Error('disk full')
    })

    const reply = await apply(importOp())

    expect(reply).toEqual({ requestId: 'r1', error: 'disk full' })
    const state = store.getState()
    expect(state.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([userTabId])
    expect(state.openFiles.map((file) => [file.id, file.isDirty])).toEqual([[userFileId, true]])
    expect(state.editorDrafts[userFileId]).toBe('unsaved user data')
    const unifiedIds = state.unifiedTabsByWorktree[WT]?.map((tab) => tab.entityId)
    expect(unifiedIds?.toSorted()).toEqual([userTabId, userFileId].toSorted())
    const groups = state.groupsByWorktree[WT] ?? []
    expect(groups.flatMap((group) => group.tabOrder).toSorted()).toEqual(
      state.unifiedTabsByWorktree[WT]?.map((tab) => tab.id).toSorted()
    )
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(state.recoveryImportKeyByWorktreeId[WT]).toBeUndefined()
    store.getState().reconcileWorktreeTabModel(WT)
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([userTabId])
    expect(store.getState().openFiles.map((file) => file.id)).toEqual([userFileId])
  })

  it('keeps an imported tab the user renamed while the import failed to persist', async () => {
    const { store, session, apply } = setup()
    session.flush.mockImplementationOnce(async () => {
      store.getState().setTabCustomTitle('tab-new', 'mine')
      throw new Error('disk full')
    })

    expect(await apply(importOp())).toEqual({ requestId: 'r1', error: 'disk full' })

    store.getState().reconcileWorktreeTabModel(WT)
    const state = store.getState()
    expect(state.tabsByWorktree[WT]?.map((tab) => [tab.id, tab.customTitle])).toEqual([
      ['tab-new', 'mine']
    ])
    expect(state.unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-new'])
    expect(state.groupsByWorktree[WT]?.map((group) => [group.id, group.tabOrder])).toEqual([
      ['group-new', ['tab-new']]
    ])
    expect(state.activeGroupIdByWorktree[WT]).toBe('group-new')
    expect(state.openFiles).toEqual([])
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    expect(state.recoveryImportKeyByWorktreeId[WT]).toBeUndefined()
    const rewritten = session.set.mock.calls[1][0]
    expect(rewritten.sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    expect(rewritten.recoveryImportKeyByWorktreeId ?? {}).toEqual({})
  })

  it('drops the dormant binding of each recovered terminal the rollback removes, keeping the rest', async () => {
    const { store, session, apply } = setup()
    session.flush.mockImplementationOnce(async () => {
      store.getState().setTabCustomTitle('tab-two', 'mine')
      throw new Error('disk full')
    })

    expect(await apply(splitImportOp(leaf('group-new'), 'group-new', ['group-new']))).toEqual({
      requestId: 'r1',
      error: 'disk full'
    })

    const state = store.getState()
    expect(state.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-two'])
    expect(state.sleepingAgentSessionsByPaneKey).toEqual({ [SECOND_PANE_KEY]: secondRecord })
    expect(session.set.mock.calls[1][0].sleepingAgentSessionsByPaneKey).toEqual({
      [SECOND_PANE_KEY]: secondRecord
    })
  })

  it('prunes a removed import group from the split layout and moves the active group to a survivor', async () => {
    const { store, session, apply } = setup()
    const op = splitImportOp(
      {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.3,
        first: leaf('group-new'),
        second: leaf('group-file')
      },
      'group-new',
      ['group-new', 'group-file']
    )
    session.flush.mockImplementationOnce(async () => {
      store.getState().setEditorDraft(IMPORTED_FILE, 'unsaved import edit')
      store.getState().markFileDirty(IMPORTED_FILE, true)
      throw new Error('disk full')
    })

    expect(await apply(op)).toEqual({ requestId: 'r1', error: 'disk full' })

    const state = store.getState()
    expect(state.groupsByWorktree[WT]?.map((group) => group.id)).toEqual(['group-file'])
    expect(state.layoutByWorktree[WT]).toEqual(leaf('group-file'))
    expect(state.activeGroupIdByWorktree[WT]).toBe('group-file')
    const rewritten = session.set.mock.calls[1][0]
    expect(rewritten.tabGroupLayouts[WT]).toEqual(leaf('group-file'))
    expect(rewritten.activeGroupIdByWorktree[WT]).toBe('group-file')
  })

  it('keeps surviving branches and split ratios when rollback removes a nested import group', async () => {
    const { store, session, apply } = setup()
    const op = splitImportOp(
      {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.25,
        first: leaf('group-file'),
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.6,
          first: leaf('group-new'),
          second: leaf('group-two')
        }
      },
      'group-two'
    )
    session.flush.mockImplementationOnce(async () => {
      store.getState().setEditorDraft(IMPORTED_FILE, 'unsaved import edit')
      store.getState().markFileDirty(IMPORTED_FILE, true)
      store.getState().setTabCustomTitle('tab-two', 'mine')
      throw new Error('disk full')
    })

    expect(await apply(op)).toEqual({ requestId: 'r1', error: 'disk full' })

    const expectRolledBackLayout = (): void => {
      const state = store.getState()
      expect(state.groupsByWorktree[WT]?.map((group) => group.id)).toEqual([
        'group-file',
        'group-two'
      ])
      expect(state.layoutByWorktree[WT]).toEqual({
        type: 'split',
        direction: 'horizontal',
        ratio: 0.25,
        first: leaf('group-file'),
        second: leaf('group-two')
      })
      expect(state.activeGroupIdByWorktree[WT]).toBe('group-two')
    }
    expectRolledBackLayout()
    store.getState().reconcileWorktreeTabModel(WT)
    expectRolledBackLayout()
  })

  it('drops every removed import group from a split the user resized while the import failed', async () => {
    const { store, session, apply } = setup()
    const op = splitImportOp(
      {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.3,
        first: leaf('group-new'),
        second: leaf('group-two')
      },
      'group-new',
      ['group-new', 'group-two']
    )
    session.flush.mockImplementationOnce(async () => {
      store.getState().setTabGroupSplitRatio(WT, '', 0.7)
      store.getState().focusGroup(WT, 'group-two')
      throw new Error('disk full')
    })

    expect(await apply(op)).toEqual({ requestId: 'r1', error: 'disk full' })

    const state = store.getState()
    expect(state.groupsByWorktree[WT] ?? []).toEqual([])
    expect(state.layoutByWorktree[WT]).toBeUndefined()
    expect(state.activeGroupIdByWorktree[WT]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey).toEqual({})
  })

  it('keeps an imported file the user edited, with its tab, when the import fails to persist', async () => {
    const { store, session, apply } = setup()
    const filePath = '/repo1/wt/src/a.ts'
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
            activeTabId: 'tab-new',
            tabOrder: ['tab-new', filePath],
            recentTabIds: [filePath, 'tab-new']
          })
        ]
      }
    }
    session.flush.mockImplementationOnce(async () => {
      store.getState().setEditorDraft(filePath, 'unsaved import edit')
      store.getState().markFileDirty(filePath, true)
      throw new Error('disk full')
    })

    expect(await apply(op)).toEqual({ requestId: 'r1', error: 'disk full' })

    store.getState().reconcileWorktreeTabModel(WT)
    const state = store.getState()
    expect(state.openFiles.map((file) => [file.id, file.isDirty])).toEqual([[filePath, true]])
    expect(state.editorDrafts[filePath]).toBe('unsaved import edit')
    expect(state.unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([filePath])
    expect(state.groupsByWorktree[WT]).toEqual([
      expect.objectContaining({
        id: 'group-new',
        activeTabId: filePath,
        tabOrder: [filePath],
        recentTabIds: [filePath]
      })
    ])
    expect(state.tabsByWorktree[WT]).toBeUndefined()
    expect(state.terminalLayoutsByTabId['tab-new']).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(state.recoveryImportKeyByWorktreeId[WT]).toBeUndefined()
  })

  it('removes an imported file whose clean load only stamped its disk baseline, so a retry lands', async () => {
    const { store, session, apply } = setup()
    session.flush.mockImplementationOnce(async () => {
      store.getState().setLastKnownDiskSignature('/repo1/wt/src/a.ts', 'loaded-disk-signature')
      throw new Error('disk full')
    })

    expect(await apply(importOp())).toEqual({ requestId: 'r1', error: 'disk full' })
    expect(store.getState().openFiles).toEqual([])
    expect(store.getState().recoveryImportKeyByWorktreeId[WT]).toBeUndefined()

    expect(await apply(importOp())).toEqual({
      requestId: 'r1',
      outcome: { ok: true, claimed: null }
    })
    expect(store.getState().openFiles.map((file) => file.id)).toEqual(['/repo1/wt/src/a.ts'])
  })

  it('evaluates a retry only after the earlier import to that worktree rolls back', async () => {
    const { store, session, apply } = setup()
    let failFirstFlush!: (error: Error) => void
    session.flush.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failFirstFlush = reject
        })
    )
    const first = apply(importOp())
    await vi.waitFor(() => expect(session.flush).toHaveBeenCalledTimes(1))
    const retry = apply(importOp())
    await Promise.resolve()
    expect(session.set).toHaveBeenCalledTimes(1)

    failFirstFlush(new Error('disk full'))

    expect(await first).toEqual({ requestId: 'r1', error: 'disk full' })
    expect(await retry).toEqual({ requestId: 'r1', outcome: { ok: true, claimed: null } })
    expect(session.set).toHaveBeenCalledTimes(3)
    const state = store.getState()
    expect(state.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-new'])
    expect(state.recoveryImportKeyByWorktreeId[WT]).toBe('key')
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    expect(session.set.mock.calls[1][0].recoveryImportKeyByWorktreeId ?? {}).toEqual({})
    expect(session.set.mock.calls[2][0].recoveryImportKeyByWorktreeId).toEqual({ [WT]: 'key' })
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
