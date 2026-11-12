import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCompatibleRuntimeStatusResponse } from '../../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
const appStore = vi.hoisted(() => ({
  getState: vi.fn<() => { runtimeStatusByEnvironmentId: Map<string, unknown> }>(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

const RESUME = { key: 'session_id', id: 'provider-session-1' } as const
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

type RpcCall = { method?: string; params?: Record<string, unknown> }

function okResponse(result: unknown): unknown {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'runtime-remote' } }
}

describe('createRemoteRuntimePtyTransport: restore spawn intent', () => {
  const runtimeCall = vi.fn<(args: RpcCall) => Promise<unknown>>()
  let capabilities: string[] = []
  let ensureResponse: unknown = null

  beforeEach(() => {
    vi.resetModules()
    runtimeCall.mockReset()
    appStore.getState.mockReset().mockImplementation(() => {
      throw new Error('These transport fixtures must not read app-store ownership')
    })
    capabilities = ['agent-session.host-authority.v1']
    ensureResponse = {
      id: 'rpc',
      ok: false,
      error: {
        code: 'terminal_spawn_deferred',
        message: 'terminal_spawn_deferred:paused',
        data: { reason: 'paused' }
      },
      _meta: { runtimeId: 'runtime-remote' }
    }
    runtimeCall.mockImplementation(async (args: RpcCall) =>
      args.method === 'status.get'
        ? okResponse({
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities
          })
        : ensureResponse
    )
    vi.stubGlobal('window', {
      ...globalThis.window,
      api: {
        ...globalThis.window?.api,
        runtimeEnvironments: {
          ...globalThis.window?.api?.runtimeEnvironments,
          call: runtimeCall,
          subscribe: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function connectResume(
    callbacks: Record<string, unknown> = {},
    saved = false
  ): Promise<unknown> {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      launchAgent: 'claude',
      resumeProviderSession: RESUME,
      ...(saved ? { resumeOrigin: 'saved' as const } : {}),
      tabId: 'tab-1',
      leafId: LEAF_ID
    })
    return transport.connect({ url: '', resumeSpawnIntent: 'automatic-restore', callbacks })
  }

  it.each([false, true])(
    'keeps saved-origin negotiation stable through an unknown outcome (capability %s)',
    async (modern) => {
      if (modern) {
        capabilities.push('agent-session.saved-resume-origin.v1')
      }
      let attempts = 0
      runtimeCall.mockImplementation(async (args: RpcCall) => {
        if (args.method === 'status.get') {
          return okResponse({
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities
          })
        }
        if (args.method === 'terminal.ensureAgentSession' && attempts++ === 0) {
          capabilities = [...capabilities, 'agent-session.saved-resume-origin.v1']
          throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
            code: 'runtime_timeout'
          })
        }
        return ensureResponse
      })
      const onSpawnDeferred = vi.fn()
      await connectResume({ onSpawnDeferred }, true)
      const requests = runtimeCall.mock.calls
        .map(([call]) => call)
        .filter((call) => call.method === 'terminal.ensureAgentSession')
      expect(requests).toHaveLength(2)
      expect(requests[1].params).toEqual(requests[0].params)
      expect(requests[0].params).toMatchObject({ kind: 'explicit', providerSession: RESUME })
      if (modern) {
        expect(requests[0].params).toHaveProperty('resumeOrigin', 'saved')
      } else {
        expect(requests[0].params).not.toHaveProperty('resumeOrigin')
      }
      expect(onSpawnDeferred).toHaveBeenCalledWith('paused')
      expect(appStore.getState).not.toHaveBeenCalled()
    }
  )

  it.each([true, false])(
    'retains fresh effort deletion negotiation across an unknown native outcome (%s)',
    async (supported) => {
      appStore.getState.mockReturnValue({ runtimeStatusByEnvironmentId: new Map() })
      let attempts = 0
      let upgraded = supported
      runtimeCall.mockImplementation(async (args: RpcCall) => {
        if (args.method === 'status.get') {
          const status = createCompatibleRuntimeStatusResponse('runtime-remote')
          if (!upgraded) {
            status.result.capabilities = status.result.capabilities?.filter(
              (value) => value !== 'agent.launch.terminal-option-edits.v1'
            )
          }
          return status
        }
        if (args.method === 'terminal.createAgentSession' && attempts++ === 0) {
          upgraded = !supported
          throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
            code: 'runtime_timeout'
          })
        }
        return ensureResponse
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'repo1::/remote/wt',
        launchAgent: 'antigravity',
        tabId: 'tab-1',
        leafId: LEAF_ID,
        freshAgentLaunch: {
          prompt: '',
          promptDelivery: 'auto-submit',
          terminalOptionEdits: { effort: null }
        }
      })
      const onSpawnDeferred = vi.fn()
      await transport.connect({ url: '', callbacks: { onSpawnDeferred } })
      const requests = runtimeCall.mock.calls
        .map(([call]) => call)
        .filter((call) => call.method === 'terminal.createAgentSession')
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual(requests[0])
      expect(requests[0].params).toMatchObject({
        agent: 'antigravity',
        clientOperationId: expect.any(String)
      })
      if (supported) {
        expect(requests[0]).toMatchObject({
          expectedEnvironmentRuntimeId: 'runtime-remote',
          params: { terminalOptionEdits: { effort: null } }
        })
      } else {
        expect(requests[0].params).not.toHaveProperty('terminalOptionEdits')
      }
      expect(runtimeCall.mock.calls.some(([call]) => call.method === 'terminal.create')).toBe(false)
      expect(onSpawnDeferred).toHaveBeenCalledWith('paused')
    }
  )
})
