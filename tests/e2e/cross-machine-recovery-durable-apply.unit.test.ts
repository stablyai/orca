import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '../../src/renderer/src/lib/agent-status'
import type { SleepingAgentSessionRecord } from '../../src/shared/agent-session-resume'
import type {
  CrossMachineRecoveryApplyOp,
  RecoveryWorkspaceFragment
} from '../../src/shared/cross-machine-recovery-session-ops'
import {
  fixture as durableStoreFixture,
  type DelayedAuthority
} from '../../src/main/persistence/loading-store/profile-state-delayed-authority-fixture'
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

type DurableFixture = Awaited<ReturnType<typeof durableStoreFixture>>

const WT = 'repo1::/repo1/wt'
const SIBLING_WT = 'repo1::/repo1/wt-b'
const THIRD_WT = 'repo1::/repo1/wt-c'
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

function fragment(worktreeId = WT, tabId = 'tab-new'): RecoveryWorkspaceFragment {
  const groupId = `group-${tabId}`
  return {
    worktreeId,
    terminalTabs: [makeTab({ id: tabId, worktreeId, ptyId: null })],
    terminalLayoutsByTabId: { [tabId]: makeLayout() },
    unifiedTabs: [makeUnifiedTab({ id: tabId, worktreeId, groupId })],
    tabGroups: [makeTabGroup({ id: groupId, worktreeId, activeTabId: tabId, tabOrder: [tabId] })],
    tabGroupLayout: { type: 'leaf', groupId },
    activeGroupId: groupId,
    openFiles: [],
    activeFileId: null,
    browserWorkspaces: [],
    browserPagesByWorkspace: {},
    activeBrowserTabId: null,
    activeTabType: 'terminal',
    activeTabId: tabId
  }
}

const importOp = (): CrossMachineRecoveryApplyOp => ({
  kind: 'import',
  importKey: 'key',
  fragment: fragment(),
  records: [record]
})

const siblingImportOp = (worktreeId: string, tabId: string): CrossMachineRecoveryApplyOp => ({
  kind: 'import',
  importKey: `key-${tabId}`,
  fragment: fragment(worktreeId, tabId),
  records: []
})

const claimOp: CrossMachineRecoveryApplyOp = {
  kind: 'claim-record',
  worktreeId: WT,
  binding: { agent: record.agent, ...record.providerSession }
}

async function durableSetup() {
  const durable = await durableStoreFixture()
  const store = createTestStore()
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      repo1: [WT, SIBLING_WT, THIRD_WT].map((id) =>
        makeWorktree({ id, repoId: 'repo1', path: id.slice('repo1::'.length) })
      )
    }
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
  const apply = (requestId: string, op: CrossMachineRecoveryApplyOp) =>
    handleCrossMachineRecoveryApplyRequest(store, api, { requestId, op })
  const persisted = () => durable.readState().workspaceSession
  return { durable, store, apply, persisted }
}

// Why: a debounced renderer patch landing mid-write makes the flush drain a second write.
async function failCoalescedWriteAfterFirstCommits(
  durable: DurableFixture,
  firstWrite: ReturnType<DelayedAuthority['pause']>
): Promise<void> {
  await firstWrite.started.promise
  durable.store.patchWorkspaceSession({ activeWorktreeId: WT })
  const secondWrite = durable.authority.pause()
  firstWrite.finish.resolve()
  await secondWrite.started.promise
  secondWrite.finish.reject(new Error('disk full'))
}

describe('cross-machine recovery renderer apply over the durable write queue', () => {
  it('keeps the import a retry acknowledged when an overlapping first attempt fails', async () => {
    const { durable, store, apply, persisted } = await durableSetup()
    const gate = durable.authority.pause()
    const first = apply('first', importOp())
    await gate.started.promise
    const retry = apply('retry', importOp())
    gate.finish.reject(new Error('disk full'))

    expect(await first).toEqual({ requestId: 'first', error: 'disk full' })
    const retried = await retry
    expect.soft(retried).toEqual({ requestId: 'retry', outcome: { ok: true, claimed: null } })
    const state = store.getState()
    expect.soft(state.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-new'])
    expect.soft(state.unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual(['tab-new'])
    expect.soft(state.recoveryImportKeyByWorktreeId[WT]).toBe('key')
    expect.soft(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    const session = persisted()
    expect.soft(session.recoveryImportKeyByWorktreeId).toEqual({ [WT]: 'key' })
    expect.soft(session.sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    expect
      .soft(session.tabsByWorktree[WT].map((tab: { id: string }) => tab.id))
      .toEqual(['tab-new'])
  })

  it('writes back a failed import whose own write committed before a coalesced write failed', async () => {
    const { durable, store, apply, persisted } = await durableSetup()
    const firstWrite = durable.authority.pause()
    const imported = apply('import', importOp())
    await failCoalescedWriteAfterFirstCommits(durable, firstWrite)

    expect(await imported).toEqual({ requestId: 'import', error: 'disk full' })
    const state = store.getState()
    const session = persisted()
    expect(state.recoveryImportKeyByWorktreeId[WT]).toBeUndefined()
    expect(session.recoveryImportKeyByWorktreeId?.[WT]).toBeUndefined()
    expect(state.tabsByWorktree[WT]).toBeUndefined()
    expect(session.tabsByWorktree[WT]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
  })

  it('writes back a failed claim whose own write committed before a coalesced write failed', async () => {
    const { durable, store, apply, persisted } = await durableSetup()
    store.setState({ sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record } })
    durable.store.setWorkspaceSession({
      ...durable.store.getWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
    })
    await durable.store.flushPendingOrThrowAsync()
    expect(persisted().sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    const firstWrite = durable.authority.pause()
    const claimed = apply('claim', claimOp)
    await failCoalescedWriteAfterFirstCommits(durable, firstWrite)

    expect(await claimed).toEqual({ requestId: 'claim', error: 'disk full' })
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
    expect(persisted().sleepingAgentSessionsByPaneKey[PANE_KEY]).toEqual(record)
  })

  it('keeps a failed import out of the durable session sibling imports wrote while it ran', async () => {
    const { durable, store, apply, persisted } = await durableSetup()
    const firstWrite = durable.authority.pause()
    const failed = apply('failed', importOp())
    await firstWrite.started.promise
    const siblings = [
      apply('sibling', siblingImportOp(SIBLING_WT, 'tab-b')),
      apply('third', siblingImportOp(THIRD_WT, 'tab-c'))
    ]
    await vi.waitFor(() =>
      expect(Object.keys(store.getState().recoveryImportKeyByWorktreeId).toSorted()).toEqual(
        [WT, SIBLING_WT, THIRD_WT].toSorted()
      )
    )
    firstWrite.finish.reject(new Error('disk full'))

    expect(await failed).toEqual({ requestId: 'failed', error: 'disk full' })
    expect(await Promise.all(siblings)).toEqual([
      { requestId: 'sibling', outcome: { ok: true, claimed: null } },
      { requestId: 'third', outcome: { ok: true, claimed: null } }
    ])
    await durable.store.flushPendingOrThrowAsync()
    const expectedKeys = { [SIBLING_WT]: 'key-tab-b', [THIRD_WT]: 'key-tab-c' }
    const session = persisted()
    expect(store.getState().recoveryImportKeyByWorktreeId).toEqual(expectedKeys)
    expect(session.recoveryImportKeyByWorktreeId).toEqual(expectedKeys)
    expect(Object.keys(session.tabsByWorktree).toSorted()).toEqual(
      [SIBLING_WT, THIRD_WT].toSorted()
    )
    expect(session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
  })
})
