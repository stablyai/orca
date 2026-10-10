import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { getRuntimeAgentInventoryKey } from './runtime-agent-inventory-key'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

const runtimeEnvironmentCall = vi.fn()

vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeEnvironmentCall } } })

type ServedHostStatus = { hostPlatform?: NodeJS.Platform; scoped: boolean }

function serveHost(host: ServedHostStatus): void {
  runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
    const result =
      method === 'status.get'
        ? {
            runtimeId: 'remote-runtime',
            rendererGraphEpoch: 1,
            graphStatus: 'ready',
            authoritativeWindowId: null,
            liveTabCount: 0,
            liveLeafCount: 0,
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: host.scoped ? [PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY] : [],
            ...(host.hostPlatform ? { hostPlatform: host.hostPlatform } : {})
          }
        : method === 'preflight.refreshAgents'
          ? { agents: ['codex'] }
          : ['codex']
    return Promise.resolve({ id: method, ok: true, result, _meta: { runtimeId: 'remote-runtime' } })
  })
}

function agentCalls(): unknown[] {
  return runtimeEnvironmentCall.mock.calls
    .map(([request]) => request)
    .filter((request: { method: string }) => request.method !== 'status.get')
}

const KEY = getRuntimeAgentInventoryKey('env-1', 'wt-1')

describe('workspace agent detection on a host without workspace-scoped detection', () => {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    runtimeEnvironmentCall.mockReset()
  })

  it.each([
    ['a Windows host', { hostPlatform: 'win32' as const, scoped: false }],
    ['a host that does not report its platform', { scoped: false }]
  ])('asks to update %s instead of answering its default list', async (_label, host) => {
    serveHost(host)
    const store = createTestStore()

    await expect(store.getState().ensureRuntimeDetectedAgents('env-1', 'wt-1')).resolves.toEqual([])

    expect(agentCalls()).toEqual([])
    expect(store.getState().runtimeDetectedAgentIds[KEY]).toEqual([])
    expect(store.getState().runtimeAgentDetectionNeedsServerUpdate[KEY]).toBe(true)
    expect(store.getState().isDetectingRuntimeAgents[KEY]).toBe(false)
  })

  it('replaces a cached list with the update notice on refresh', async () => {
    serveHost({ hostPlatform: 'win32', scoped: false })
    const store = createTestStore()
    store.setState({ runtimeDetectedAgentIds: { [KEY]: ['claude'] } })

    await expect(store.getState().refreshRuntimeDetectedAgents('env-1', 'wt-1')).resolves.toEqual(
      []
    )

    expect(agentCalls()).toEqual([])
    expect(store.getState().runtimeDetectedAgentIds[KEY]).toEqual([])
    expect(store.getState().runtimeAgentDetectionNeedsServerUpdate[KEY]).toBe(true)
    expect(store.getState().isRefreshingRuntimeAgents[KEY]).toBe(false)
  })

  it('still answers with the default list of a known non-Windows host', async () => {
    serveHost({ hostPlatform: 'linux', scoped: false })
    const store = createTestStore()

    await expect(store.getState().ensureRuntimeDetectedAgents('env-1', 'wt-1')).resolves.toEqual([
      'codex'
    ])

    expect(agentCalls()).toEqual([
      expect.objectContaining({ method: 'preflight.detectAgents', params: undefined })
    ])
    expect(store.getState().runtimeAgentDetectionNeedsServerUpdate[KEY]).toBeUndefined()
  })

  it('answers concurrent workspaces of a known non-Windows host with its default list', async () => {
    serveHost({ hostPlatform: 'linux', scoped: false })
    const store = createTestStore()

    const lists = await Promise.all([
      store.getState().ensureRuntimeDetectedAgents('env-1', 'wt-1'),
      store.getState().ensureRuntimeDetectedAgents('env-1', 'wt-2')
    ])

    expect(lists).toEqual([['codex'], ['codex']])
    expect(store.getState().runtimeAgentDetectionNeedsServerUpdate).toEqual({})
  })

  it('still answers the host default list of an old Windows host', async () => {
    serveHost({ hostPlatform: 'win32', scoped: false })
    const store = createTestStore()

    await expect(store.getState().ensureRuntimeDetectedAgents('env-1')).resolves.toEqual(['codex'])

    expect(store.getState().runtimeAgentDetectionNeedsServerUpdate).toEqual({})
  })

  it('clears the notice once the host is updated', async () => {
    serveHost({ hostPlatform: 'win32', scoped: false })
    const store = createTestStore()
    await store.getState().ensureRuntimeDetectedAgents('env-1', 'wt-1')

    serveHost({ hostPlatform: 'win32', scoped: true })
    await expect(store.getState().ensureRuntimeDetectedAgents('env-1', 'wt-1')).resolves.toEqual([
      'codex'
    ])

    expect(agentCalls()).toEqual([
      expect.objectContaining({ method: 'preflight.detectAgents', params: { worktreeId: 'wt-1' } })
    ])
    expect(store.getState().runtimeDetectedAgentIds[KEY]).toEqual(['codex'])
    expect(store.getState().runtimeAgentDetectionNeedsServerUpdate[KEY]).toBeUndefined()
  })

  it('drops the notice with its environment', async () => {
    serveHost({ hostPlatform: 'win32', scoped: false })
    const store = createTestStore()
    await store.getState().ensureRuntimeDetectedAgents('env-1', 'wt-1')

    store.getState().clearRuntimeDetectedAgents('env-1')

    expect(store.getState().runtimeAgentDetectionNeedsServerUpdate).toEqual({})
  })
})
