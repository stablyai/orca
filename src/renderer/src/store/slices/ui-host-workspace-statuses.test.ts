import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createUIStore } from './ui-slice-test-harness'
import type * as RuntimeRpcClient from '../../runtime/runtime-rpc-client'

type RuntimeRpcClientModule = typeof RuntimeRpcClient

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('../../runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<RuntimeRpcClientModule>()),
  callRuntimeRpc
}))

const hostColumns = [
  { id: 'status-8', label: '🏠 主控台' },
  { id: 'status-6', label: '🔥 今天收尾' },
  { id: 'in-progress', label: 'In progress' }
]

describe('fetchHostWorkspaceStatuses', () => {
  beforeEach(() => {
    callRuntimeRpc.mockReset()
  })

  it('drops a reply that arrives after a newer one', async () => {
    let answerOld: (value: unknown) => void = () => {}
    callRuntimeRpc
      .mockImplementationOnce(() => new Promise((resolve) => (answerOld = resolve)))
      .mockResolvedValueOnce({ ui: { workspaceStatuses: [{ id: 'status-9', label: 'New' }] } })
    const store = createUIStore()

    const older = store.getState().fetchHostWorkspaceStatuses('env-1')
    await store.getState().fetchHostWorkspaceStatuses('env-1')
    answerOld({ ui: { workspaceStatuses: hostColumns } })
    await older

    expect(store.getState().hostWorkspaceStatuses['env-1']?.map((status) => status.id)).toEqual([
      'status-9'
    ])
  })
})

describe('host workspace statuses after the host is retired', () => {
  function pairedEnvironment(pairingRevision: number) {
    return {
      id: 'env-1',
      name: 'env-1',
      createdAt: 1,
      updatedAt: pairingRevision,
      pairingRevision,
      lastUsedAt: null,
      runtimeId: 'env-1',
      preferredEndpointId: 'endpoint',
      endpoints: [
        { id: 'endpoint', kind: 'websocket' as const, label: 'env-1', endpoint: 'ws://host' }
      ]
    }
  }

  it("drops the old peer's columns, and its late reply, when the id is re-paired to another machine", async () => {
    let answerOld: (value: unknown) => void = () => {}
    callRuntimeRpc.mockReset()
    callRuntimeRpc.mockImplementationOnce(() => new Promise((resolve) => (answerOld = resolve)))
    useAppStore.getState().setRuntimeEnvironments([pairedEnvironment(1)])
    useAppStore.setState({ hostWorkspaceStatuses: { 'env-1': hostColumns } })
    const inFlight = useAppStore.getState().fetchHostWorkspaceStatuses('env-1')

    useAppStore.getState().setRuntimeEnvironments([pairedEnvironment(2)])
    answerOld({ ui: { workspaceStatuses: hostColumns } })
    await inFlight

    expect(useAppStore.getState().hostWorkspaceStatuses['env-1']).toBeUndefined()
  })
})
