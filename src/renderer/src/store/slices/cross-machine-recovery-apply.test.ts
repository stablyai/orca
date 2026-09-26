import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type {
  CrossMachineRecoveryApplyOp,
  RecoveryWorkspaceFragment
} from '../../../../shared/cross-machine-recovery-session-ops'
import { handleCrossMachineRecoveryApplyRequest } from './cross-machine-recovery-apply'
import { createStoreSessionMockApi } from './store-session-test-harness'
import {
  createTestStore,
  makeLayout,
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
    const reply = await apply({ kind: 'import', fragment: fragment(), records: [record] })

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
    expect(session.set).toHaveBeenCalledTimes(1)
    const persisted = session.set.mock.calls[0][0]
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

    const reply = await apply({ kind: 'import', fragment: fragment(), records: [record] })

    expect(fetchWorktrees).toHaveBeenCalledTimes(1)
    expect(fetchWorktrees).toHaveBeenCalledWith('repo1', { forceLocalOwner: true })
    expect(reply).toEqual({ requestId: 'r1', outcome: { ok: true, claimed: null } })
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-new'])
  })

  it('fails the import instead of dropping the layout when the worktree stays unknown', async () => {
    const { store, session, apply } = setup()
    store.setState({ worktreesByRepo: { repo1: [] } })
    vi.spyOn(store.getState(), 'fetchWorktrees').mockResolvedValue(true)

    const reply = await apply({ kind: 'import', fragment: fragment(), records: [record] })

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

    const reply = await apply({ kind: 'import', fragment: fragment(), records: [record] })

    expect(reply).toEqual({
      requestId: 'r1',
      outcome: { ok: false, code: 'recovery_destination_not_empty' }
    })
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['existing'])
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(session.set).not.toHaveBeenCalled()
  })

  it('claims a recovery record exactly once and restores it', async () => {
    const { store, session, apply } = setup()
    store.setState({ sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record } })
    const claim: CrossMachineRecoveryApplyOp = {
      kind: 'claim-record',
      worktreeId: WT,
      providerSessionId: 'session-1'
    }

    expect(await apply(claim)).toEqual({ requestId: 'r1', outcome: { ok: true, claimed: record } })
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(await apply(claim)).toEqual({ requestId: 'r1', outcome: { ok: true, claimed: null } })

    await apply({ kind: 'restore-record', record })
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    expect(session.flush).toHaveBeenCalledTimes(3)
  })
})
