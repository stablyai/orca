import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('../../runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))

const hostColumns = [
  { id: 'status-8', label: '🏠 主控台' },
  { id: 'status-6', label: '🔥 今天收尾' },
  { id: 'in-progress', label: 'In progress' }
]

describe('fetchHostWorkspaceStatuses', () => {
  beforeEach(() => {
    callRuntimeRpc.mockReset()
  })

  it("stores the host's columns from ui.get without touching the local list", async () => {
    callRuntimeRpc.mockResolvedValue({ ui: { workspaceStatuses: hostColumns } })
    const store = createUIStore()
    const local = store.getState().workspaceStatuses

    await store.getState().fetchHostWorkspaceStatuses('env-1')

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'ui.get',
      undefined,
      expect.anything()
    )
    expect(store.getState().hostWorkspaceStatuses['env-1']?.map((status) => status.id)).toEqual([
      'status-8',
      'status-6',
      'in-progress'
    ])
    expect(store.getState().workspaceStatuses).toBe(local)
  })

  it('keeps the last columns when the host is unreachable', async () => {
    const store = createUIStore()
    callRuntimeRpc.mockResolvedValueOnce({ ui: { workspaceStatuses: hostColumns } })
    await store.getState().fetchHostWorkspaceStatuses('env-1')
    callRuntimeRpc.mockRejectedValueOnce(new Error('offline'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await store.getState().fetchHostWorkspaceStatuses('env-1')

    expect(store.getState().hostWorkspaceStatuses['env-1']).toHaveLength(3)
  })

  it('stores no columns, not the defaults, when the host sends none', async () => {
    callRuntimeRpc.mockResolvedValue({ ui: {} })
    const store = createUIStore()

    await store.getState().fetchHostWorkspaceStatuses('env-1')

    expect(store.getState().hostWorkspaceStatuses['env-1'] ?? []).toEqual([])
  })

  it('keeps the stored list identity when the host resends the same columns', async () => {
    callRuntimeRpc.mockResolvedValue({ ui: { workspaceStatuses: hostColumns } })
    const store = createUIStore()
    await store.getState().fetchHostWorkspaceStatuses('env-1')
    const first = store.getState().hostWorkspaceStatuses

    await store.getState().fetchHostWorkspaceStatuses('env-1')

    expect(store.getState().hostWorkspaceStatuses).toBe(first)
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
