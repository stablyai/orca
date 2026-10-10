import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'

const rpc = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn(), status: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<typeof RuntimeRpcClientModule>()),
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: rpc.supports,
  getRuntimeEnvironmentStatus: rpc.status
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// @ts-expect-error -- minimal API stub for the store under test
globalThis.window = { api: {} }
import { createTestStore } from './store-test-helpers'
import { getRuntimeAgentInventoryKey } from './runtime-agent-inventory-key'
import { makeWorktree, TEST_REPO } from './worktrees-slice-test-fixtures'

function environment(pairingRevision: number): PublicKnownRuntimeEnvironment {
  return {
    id: 'detection-peer',
    name: 'Paired host',
    createdAt: 1,
    updatedAt: pairingRevision,
    pairingRevision,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [],
    preferredEndpointId: 'host'
  }
}

function deferredAgents() {
  let resolve!: (agents: TuiAgent[]) => void
  const promise = new Promise<TuiAgent[]>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

const WORKTREE = 'repo::/workspace'
const WORKSPACE_KEY = getRuntimeAgentInventoryKey('detection-peer', WORKTREE)

beforeEach(() => {
  rpc.call.mockReset()
  rpc.supports.mockReset()
  rpc.status.mockReset()
  createTestStore().getState().clearRuntimeDetectedAgents('detection-peer')
})

describe('runtime detection across a re-pair', () => {
  it('does not retarget an old refresh fallback to the replacement pairing', async () => {
    const store = createTestStore()
    let failOld!: (error: Error) => void
    rpc.call.mockReturnValueOnce(
      new Promise((_, reject) => {
        failOld = reject
      })
    )
    store.getState().setRuntimeEnvironments([environment(1)])
    const old = store.getState().refreshRuntimeDetectedAgents('detection-peer')
    store.getState().setRuntimeEnvironments([environment(2)])
    rpc.call.mockResolvedValueOnce(['codex'])
    await store.getState().ensureRuntimeDetectedAgents('detection-peer')
    failOld(
      new RuntimeRpcCallError({
        id: 'refresh',
        ok: false,
        error: { code: 'method_not_found', message: 'Unsupported method' }
      })
    )
    await old
    expect(rpc.call).toHaveBeenCalledTimes(2)
    expect(store.getState().runtimeDetectedAgentIds['detection-peer']).toEqual(['codex'])
  })

  it.each(['detect', 'refresh'] as const)(
    'retires cached %s results when the environment is re-paired',
    async (operation) => {
      const store = createTestStore()
      store.getState().setRuntimeEnvironments([environment(1)])
      rpc.call.mockResolvedValueOnce(operation === 'detect' ? ['claude'] : { agents: ['claude'] })
      await (operation === 'detect'
        ? store.getState().ensureRuntimeDetectedAgents('detection-peer')
        : store.getState().refreshRuntimeDetectedAgents('detection-peer'))
      store.getState().setRuntimeEnvironments([environment(2)])
      expect(store.getState().runtimeDetectedAgentIds['detection-peer']).toBeUndefined()
      rpc.call.mockResolvedValueOnce(['codex'])
      await expect(store.getState().ensureRuntimeDetectedAgents('detection-peer')).resolves.toEqual(
        ['codex']
      )
      expect(rpc.call).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    ['detect', true],
    ['detect', false],
    ['refresh', true],
    ['refresh', false]
  ] as const)('fences old %s replies finishing first=%s', async (operation, oldFirst) => {
    const store = createTestStore()
    const oldReply = deferredAgents()
    const replacementReply = deferredAgents()
    rpc.call.mockReturnValueOnce(
      operation === 'detect' ? oldReply.promise : oldReply.promise.then((agents) => ({ agents }))
    )
    rpc.call.mockReturnValueOnce(replacementReply.promise)
    store.getState().setRuntimeEnvironments([environment(1)])
    const old =
      operation === 'detect'
        ? store.getState().ensureRuntimeDetectedAgents('detection-peer')
        : store.getState().refreshRuntimeDetectedAgents('detection-peer')
    store.getState().setRuntimeEnvironments([environment(2)])
    const current = store.getState().ensureRuntimeDetectedAgents('detection-peer')
    expect(current).not.toBe(old)
    expect(rpc.call).toHaveBeenCalledTimes(2)
    if (oldFirst) {
      oldReply.resolve(['claude'])
      await old
      expect(store.getState().runtimeDetectedAgentIds['detection-peer']).toBeUndefined()
      expect(store.getState().isDetectingRuntimeAgents['detection-peer']).toBe(true)
    }
    replacementReply.resolve(['codex'])
    await expect(current).resolves.toEqual(['codex'])
    if (!oldFirst) {
      oldReply.resolve(['claude'])
      await old
    }
    expect(store.getState().runtimeDetectedAgentIds['detection-peer']).toEqual(['codex'])
  })

  it('sends a workspace probe whose capability check straddles a re-pair fenced to the retired pairing', async () => {
    const store = createTestStore()
    let answerCapability!: (supported: boolean) => void
    rpc.supports.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        answerCapability = resolve
      })
    )
    rpc.call.mockResolvedValue(['claude'])
    store.getState().setRuntimeEnvironments([environment(1)])
    const old = store.getState().ensureRuntimeDetectedAgents('detection-peer', WORKTREE)
    store.getState().setRuntimeEnvironments([environment(2)])
    answerCapability(true)
    await old
    expect(rpc.call).toHaveBeenCalledTimes(1)
    expect(rpc.call.mock.calls[0]?.[3]).toEqual({ expectedEnvironmentPairingRevision: 1 })
    expect(store.getState().runtimeDetectedAgentIds[WORKSPACE_KEY]).toBeUndefined()
  })

  it("fences an old host's SSH-target probe to the pairing captured before its capability wait", async () => {
    const store = createTestStore()
    let answerCapability!: (supported: boolean) => void
    rpc.supports.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        answerCapability = resolve
      })
    )
    rpc.status.mockResolvedValue({ capabilities: [], hostPlatform: 'win32' })
    rpc.call.mockResolvedValue(['claude'])
    store.setState({
      repos: [{ ...TEST_REPO, connectionId: 'target', executionHostId: 'runtime:detection-peer' }],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: WORKTREE, repoId: TEST_REPO.id })] }
    })
    store.getState().setRuntimeEnvironments([environment(1)])
    const old = store.getState().ensureRuntimeDetectedAgents('detection-peer', WORKTREE)
    store.getState().setRuntimeEnvironments([environment(2)])
    answerCapability(false)
    await old
    expect(rpc.call.mock.calls.map((call) => [call[1], call[3]])).toEqual([
      ['preflight.detectRemoteAgents', { expectedEnvironmentPairingRevision: 1 }]
    ])
  })

  it("drops a retired pairing's needs-update flag", async () => {
    const store = createTestStore()
    rpc.supports.mockResolvedValue(false)
    rpc.status.mockResolvedValue({ capabilities: [], hostPlatform: 'win32' })
    store.getState().setRuntimeEnvironments([environment(1)])
    await store.getState().ensureRuntimeDetectedAgents('detection-peer', WORKTREE)
    expect(store.getState().runtimeAgentDetectionNeedsServerUpdate[WORKSPACE_KEY]).toBe(true)
    store.getState().setRuntimeEnvironments([environment(2)])
    expect(store.getState().runtimeAgentDetectionNeedsServerUpdate[WORKSPACE_KEY]).toBeUndefined()
    rpc.supports.mockResolvedValue(true)
    rpc.call.mockResolvedValue(['codex'])
    await expect(
      store.getState().ensureRuntimeDetectedAgents('detection-peer', WORKTREE)
    ).resolves.toEqual(['codex'])
    expect(store.getState().runtimeAgentDetectionNeedsServerUpdate[WORKSPACE_KEY]).toBeUndefined()
  })
})
