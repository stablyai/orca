// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'

const ENV = 'laptop-env'
const HOST = toRuntimeExecutionHostId(ENV)
const child = (parent: string): AgentStatusOrchestrationContext => ({
  taskId: 'task',
  dispatchId: 'dispatch',
  parentPaneKey: parent
})

async function makeStore() {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  return createTestStore()
}

describe('remote orchestration projection', () => {
  // The first store import is a cold load of the whole renderer graph.
  beforeAll(async () => {
    await makeStore()
  }, 120_000)

  it("keeps a remote host's parent link next to the local map instead of replacing it", async () => {
    const store = await makeStore()
    const local = child('local-parent')
    store.getState().setRuntimeAgentOrchestrationByPaneKey({ 'local-child': local })

    store
      .getState()
      .setRuntimeAgentOrchestrationByPaneKey({ 'remote-child': child('remote-parent') }, HOST)
    // The next local window-graph reply must not wipe the remote entries either.
    store.getState().setRuntimeAgentOrchestrationByPaneKey({ 'local-child': local })

    const map = store.getState().runtimeAgentOrchestrationByPaneKey
    expect(map['remote-child']?.parentPaneKey).toBe('remote-parent')
    expect(map['local-child']?.parentPaneKey).toBe('local-parent')
  })

  it("replaces only that host's entries on its next pull", async () => {
    const store = await makeStore()
    store.getState().setRuntimeAgentOrchestrationByPaneKey({ a: child('p1') }, HOST)
    store.getState().setRuntimeAgentOrchestrationByPaneKey({ b: child('p2') }, HOST)
    expect(Object.keys(store.getState().runtimeAgentOrchestrationByPaneKey)).toEqual(['b'])
  })

  it('pulls the host map for an environment and applies it under that host', async () => {
    const store = await makeStore()
    const call = vi
      .fn()
      .mockResolvedValue({ byPaneKey: { 'remote-child': child('remote-parent') } })
    const { pullRemoteOrchestration } = await import('./remote-orchestration-sync')
    await pullRemoteOrchestration(store, ENV, call)
    expect(call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: ENV },
      'status.agentOrchestration',
      undefined,
      { background: true }
    )
    expect(store.getState().runtimeAgentOrchestrationByPaneKey['remote-child']?.parentPaneKey).toBe(
      'remote-parent'
    )
  })

  it('keeps the last map when an older host lacks the method', async () => {
    const store = await makeStore()
    store.getState().setRuntimeAgentOrchestrationByPaneKey({ a: child('p1') }, HOST)
    const { pullRemoteOrchestration } = await import('./remote-orchestration-sync')
    await pullRemoteOrchestration(
      store,
      ENV,
      vi.fn().mockRejectedValue(new Error('method_not_found'))
    )
    expect(Object.keys(store.getState().runtimeAgentOrchestrationByPaneKey)).toEqual(['a'])
  })
})
