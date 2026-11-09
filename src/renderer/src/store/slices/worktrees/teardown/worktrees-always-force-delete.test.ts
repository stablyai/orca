import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../../../../../../shared/constants'
import { makeWorktree } from '../worktree.test-fixture'
import {
  makeCandidate,
  deferred
} from '../../workspace-cleanup/workspace-cleanup-slice-test-harness'
import { assertWorkspaceCleanupAgentStopApproved } from '../../workspace-cleanup/workspace-cleanup-agent-evidence'
import { makeAgentEntry } from '@/components/worktree-jump/worktree-jump-palette-test-fixtures'
import { createCompatibleRuntimeStatusResponse } from '../../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
} from '../worktrees-slice-test-harness'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  resetWorktreeSliceModuleMemory()
  resetRemoteRuntimeMocks()
  mockApi.worktrees.remove.mockResolvedValue({})
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'rpc-rm',
    ok: true,
    result: {},
    _meta: { runtimeId: 'runtime-remote' }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

it('refuses newly appeared unapproved live agent on local after preparation', async () => {
  const store = createTestStore()
  const candidate = makeCandidate({ executionHostId: 'local' })
  candidate.blockers = []
  const wt = makeWorktree({ id: candidate.worktreeId, repoId: candidate.repoId, hostId: 'local' })
  store.setState({ worktreesByRepo: { [wt.repoId]: [wt] } })
  const gate = deferred<unknown>()
  const preparation = mockApi.hooks.check
  preparation.mockReturnValueOnce(gate.promise)
  const removal = store.getState().removeWorktree({ id: wt.id, executionHostId: 'local' }, false, {
    assertBeforeDispatch: () =>
      assertWorkspaceCleanupAgentStopApproved(store.getState(), candidate, candidate)
  })
  await vi.waitFor(() => expect(preparation).toHaveBeenCalled())
  const entry = makeAgentEntry('chat', 'working', Date.now(), {
    worktreeId: wt.id,
    connectionId: null,
    terminalHandle: undefined
  })
  store.setState({ agentStatusByPaneKey: { [entry.paneKey]: entry } })
  gate.resolve({ hasHooks: false })
  expect((await removal).ok).toBe(false)
  expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
})

it('allows already-approved live agent on local after preparation', async () => {
  const store = createTestStore()
  const candidate = makeCandidate({ executionHostId: 'local' })
  candidate.blockers = ['live-agent']
  const wt = makeWorktree({ id: candidate.worktreeId, repoId: candidate.repoId, hostId: 'local' })
  store.setState({ worktreesByRepo: { [wt.repoId]: [wt] } })
  const gate = deferred<unknown>()
  const preparation = mockApi.hooks.check
  preparation.mockReturnValueOnce(gate.promise)
  const removal = store.getState().removeWorktree({ id: wt.id, executionHostId: 'local' }, false, {
    assertBeforeDispatch: () =>
      assertWorkspaceCleanupAgentStopApproved(store.getState(), candidate, candidate)
  })
  await vi.waitFor(() => expect(preparation).toHaveBeenCalled())
  const entry = makeAgentEntry('chat', 'working', Date.now(), {
    worktreeId: wt.id,
    connectionId: null,
    terminalHandle: undefined
  })
  store.setState({ agentStatusByPaneKey: { [entry.paneKey]: entry } })
  gate.resolve({ hasHooks: false })
  expect((await removal).ok).toBe(true)
  expect(mockApi.worktrees.remove).toHaveBeenCalled()
})

it('refuses newly appeared unapproved live agent on runtime:env-1 after preparation', async () => {
  const store = createTestStore()
  const candidate = makeCandidate({ executionHostId: 'runtime:env-1' })
  candidate.blockers = []
  const wt = makeWorktree({
    id: candidate.worktreeId,
    repoId: candidate.repoId,
    hostId: 'runtime:env-1'
  })
  store.setState({ worktreesByRepo: { [wt.repoId]: [wt] } })
  const gate = deferred<unknown>()
  store.setState({ trustedOrcaHooks: { repo1: { all: { approvedAt: 1 } } } })
  const preparation = runtimeEnvironmentTransportCall
  preparation.mockReturnValueOnce(gate.promise)
  const removal = store
    .getState()
    .removeWorktree({ id: wt.id, executionHostId: 'runtime:env-1' }, false, {
      assertBeforeDispatch: () =>
        assertWorkspaceCleanupAgentStopApproved(store.getState(), candidate, candidate)
    })
  await vi.waitFor(() => expect(preparation).toHaveBeenCalled())
  const entry = makeAgentEntry('chat', 'working', Date.now(), {
    worktreeId: wt.id,
    connectionId: null,
    terminalHandle: 'remote:env-1@@pty'
  })
  store.setState({ agentStatusByPaneKey: { [entry.paneKey]: entry } })
  gate.resolve(createCompatibleRuntimeStatusResponse())
  expect((await removal).ok).toBe(false)
  expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
})

it('allows already-approved live agent on runtime:env-1 after preparation', async () => {
  const store = createTestStore()
  const candidate = makeCandidate({ executionHostId: 'runtime:env-1' })
  candidate.blockers = ['live-agent']
  const wt = makeWorktree({
    id: candidate.worktreeId,
    repoId: candidate.repoId,
    hostId: 'runtime:env-1'
  })
  store.setState({ worktreesByRepo: { [wt.repoId]: [wt] } })
  const gate = deferred<unknown>()
  store.setState({ trustedOrcaHooks: { repo1: { all: { approvedAt: 1 } } } })
  const preparation = runtimeEnvironmentTransportCall
  preparation.mockReturnValueOnce(gate.promise)
  const removal = store
    .getState()
    .removeWorktree({ id: wt.id, executionHostId: 'runtime:env-1' }, false, {
      assertBeforeDispatch: () =>
        assertWorkspaceCleanupAgentStopApproved(store.getState(), candidate, candidate)
    })
  await vi.waitFor(() => expect(preparation).toHaveBeenCalled())
  const entry = makeAgentEntry('chat', 'working', Date.now(), {
    worktreeId: wt.id,
    connectionId: null,
    terminalHandle: 'remote:env-1@@pty'
  })
  store.setState({ agentStatusByPaneKey: { [entry.paneKey]: entry } })
  gate.resolve(createCompatibleRuntimeStatusResponse())
  expect((await removal).ok).toBe(true)
  expect(runtimeEnvironmentCall).toHaveBeenCalled()
})
