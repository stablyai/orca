import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

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

  function ensureParams(): Record<string, unknown> | undefined {
    for (const [args] of runtimeCall.mock.calls) {
      const call: RpcCall = args
      if (call.method === 'terminal.ensureAgentSession') {
        return call.params
      }
    }
    return undefined
  }

  it('sends the intent to a host that advertises it', async () => {
    capabilities.push('terminal.spawn-intent.v1')
    await connectResume()
    expect(ensureParams()).toMatchObject({ kind: 'explicit', spawnIntent: 'automatic-restore' })
  })

  it('omits it for an older host, whose strict params would reject the request', async () => {
    ensureResponse = okResponse({
      disposition: 'created',
      terminal: { handle: 'term-remote', worktreeId: 'repo1::/remote/wt', title: null }
    })
    await connectResume()
    expect(ensureParams()).toBeDefined()
    expect(ensureParams()).not.toHaveProperty('spawnIntent')
  })

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
    }
  )

  it('reports a deferral to the pane instead of surfacing an error', async () => {
    capabilities.push('terminal.spawn-intent.v1')
    const onError = vi.fn()
    const onSpawnDeferred = vi.fn()

    await expect(connectResume({ onError, onSpawnDeferred })).resolves.toBeUndefined()

    expect(onSpawnDeferred).toHaveBeenCalledWith('paused')
    expect(onError).not.toHaveBeenCalled()
  })
})
