import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../shared/constants'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import { makeCandidate, deferred } from './workspace-cleanup-slice-test-harness'
import { assertWorkspaceCleanupAgentStopApproved } from './workspace-cleanup-agent-evidence'
import { makeAgentEntry } from '@/components/worktree-jump/worktree-jump-palette-test-fixtures'
import { createCompatibleRuntimeStatusResponse } from '../../runtime/runtime-compatibility-test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
} from './worktrees-slice-test-harness'

beforeEach(() => {
  vi.clearAllMocks()
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

describe.each(['local', 'runtime:env-1'] as const)('consent on %s', (hostId) => {
  it.each([false, true])('checks consent after preparation: %s', async (approved) => {
    const store = createTestStore()
    const candidate = makeCandidate({ executionHostId: hostId })
    candidate.blockers = approved ? ['live-agent'] : []
    const wt = makeWorktree({ id: candidate.worktreeId, repoId: candidate.repoId, hostId })
    store.setState({ worktreesByRepo: { [wt.repoId]: [wt] } })
    const gate = deferred<unknown>()
    const local = hostId === 'local'
    if (!local) {
      store.setState({ trustedOrcaHooks: { repo1: { all: { approvedAt: 1 } } } })
    }
    const preparation = local ? mockApi.hooks.check : runtimeEnvironmentTransportCall
    preparation.mockReturnValueOnce(gate.promise)
    const removal = store.getState().removeWorktree({ id: wt.id, executionHostId: hostId }, false, {
      assertBeforeDispatch: () =>
        assertWorkspaceCleanupAgentStopApproved(store.getState(), candidate, candidate)
    })
    await vi.waitFor(() => expect(preparation).toHaveBeenCalled())
    const entry = makeAgentEntry('chat', 'working', Date.now(), {
      worktreeId: wt.id,
      connectionId: null,
      terminalHandle: local ? undefined : 'remote:env-1@@pty'
    })
    store.setState({ agentStatusByPaneKey: { [entry.paneKey]: entry } })
    gate.resolve(local ? { hasHooks: false } : createCompatibleRuntimeStatusResponse())
    expect((await removal).ok).toBe(approved)
    const destructive = local ? mockApi.worktrees.remove : runtimeEnvironmentCall
    expect(destructive).toHaveBeenCalledTimes(approved ? 1 : 0)
  })
})
