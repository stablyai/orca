import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '../../src/renderer/src/lib/agent-status'
import type { SleepingAgentSessionRecord } from '../../src/shared/agent-session-resume'
import type {
  CrossMachineRecoveryApplyOp,
  RecoveryWorkspaceFragment
} from '../../src/shared/cross-machine-recovery-session-ops'
import { fixture as durableStoreFixture } from '../../src/main/persistence/loading-store/profile-state-delayed-authority-fixture'
import { handleCrossMachineRecoveryApplyRequest } from '../../src/renderer/src/store/slices/cross-machine-recovery-apply'
import { createStoreSessionMockApi } from '../../src/renderer/src/store/slices/store-session-test-harness'
import {
  createTestStore,
  makeLayout,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  TEST_REPO
} from '../../src/renderer/src/store/slices/store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../src/renderer/src/lib/agent-status', async (importOriginal) => {
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
    openFiles: [],
    activeFileId: null,
    browserWorkspaces: [],
    browserPagesByWorkspace: {},
    activeBrowserTabId: null,
    activeTabType: 'terminal',
    activeTabId: 'tab-new'
  }
}

const importOp = (): CrossMachineRecoveryApplyOp => ({
  kind: 'import',
  importKey: 'key',
  fragment: fragment(),
  records: [record]
})

describe('cross-machine recovery renderer apply over the durable write queue', () => {
  it('keeps the import a retry acknowledged when an overlapping first attempt fails', async () => {
    const durable = await durableStoreFixture()
    const store = createTestStore()
    store.setState({
      repos: [TEST_REPO],
      worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/repo1/wt' })] }
    })
    const api = {
      session: {
        ...window.api.session,
        set: async (payload: Parameters<typeof durable.store.setWorkspaceSession>[0]) => {
          durable.store.setWorkspaceSession(payload)
        },
        flush: () => durable.store.flushPendingOrThrowAsync()
      },
      crossMachineRecovery: window.api.crossMachineRecovery
    }
    const gate = durable.authority.pause()
    const first = handleCrossMachineRecoveryApplyRequest(store, api, {
      requestId: 'first',
      op: importOp()
    })
    await gate.started.promise
    const retry = handleCrossMachineRecoveryApplyRequest(store, api, {
      requestId: 'retry',
      op: importOp()
    })
    gate.finish.reject(new Error('disk full'))

    expect(await first).toEqual({ requestId: 'first', error: 'disk full' })
    const retried = await retry
    expect.soft(retried).toEqual({ requestId: 'retry', outcome: { ok: true, claimed: null } })
    const state = store.getState()
    expect.soft(state.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-new'])
    expect.soft(state.unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-new'])
    expect.soft(state.recoveryImportKeyByWorktreeId[WT]).toBe('key')
    expect.soft(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    const persisted = durable.readState().workspaceSession
    expect.soft(persisted.recoveryImportKeyByWorktreeId).toEqual({ [WT]: 'key' })
    expect.soft(persisted.sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    expect
      .soft(persisted.tabsByWorktree[WT].map((tab: { id: string }) => tab.id))
      .toEqual(['tab-new'])
  })
})
