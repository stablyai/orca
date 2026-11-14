import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

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

  it('does not bind or publish a late account-restart result whose pane owner changed', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtySpawn = vi.fn()
    ensureResponse = okResponse({
      terminal: {
        handle: 'replacement',
        incarnationId: 'obsolete-incarnation',
        worktreeId: 'repo1::/remote/wt',
        title: 'Codex'
      }
    })
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      launchAgent: 'codex',
      tabId: 'tab-1',
      leafId: LEAF_ID,
      onPtySpawn
    })
    const result = await transport.connect({
      url: '',
      isAccountRestartCurrent: () => true,
      accountRestart: {
        requestId: 'request',
        attemptId: 'attempt',
        hostEpoch: 'host',
        pane: { worktreeId: 'repo1::/remote/wt', tabId: 'tab-1', leafId: LEAF_ID, tabCreatedAt: 1 },
        expected: { kind: 'empty', bindingGeneration: 1 }
      },
      shouldContinue: (result) => result === undefined,
      callbacks: {}
    })
    expect(result).toBeUndefined()
    expect(transport.getPtyId()).toBeNull()
    expect(onPtySpawn).not.toHaveBeenCalled()
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
      expect(onSpawnDeferred).toHaveBeenCalledWith('paused', 'terminal_spawn_deferred:paused')
    }
  )
  it('checks currency again after origin negotiation and before retrying an unknown create', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    let current = true
    let creates = 0
    capabilities.push('terminal.create-idempotency.v2')
    runtimeCall.mockImplementation(async (args: RpcCall) => {
      if (args.method === 'status.get') {
        return okResponse({
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2,
          capabilities
        })
      }
      if (args.method === 'terminal.create') {
        creates += 1
        current = false
        throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
          code: 'runtime_timeout'
        })
      }
      return ensureResponse
    })
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      tabId: 'tab-1',
      leafId: LEAF_ID
    })
    const connecting = transport.connect({
      url: '',
      isAccountRestartCurrent: () => current,
      accountRestart: {
        requestId: 'request',
        attemptId: 'attempt',
        hostEpoch: 'host',
        pane: { worktreeId: 'repo1::/remote/wt', tabId: 'tab-1', leafId: LEAF_ID, tabCreatedAt: 1 },
        expected: { kind: 'empty', bindingGeneration: 1 }
      },
      callbacks: {}
    })
    await connecting
    expect(creates).toBe(1)
    expect(transport.getPtyId()).toBeNull()
    transport.destroy?.()
  })

  it('routes mirrored account restarts through the conditional host pane create', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const hostRequests: RpcCall[] = []
    runtimeCall.mockImplementation(async (args: RpcCall) => {
      hostRequests.push(args)
      if (args.method === 'status.get') {
        return okResponse({ capabilities })
      }
      return ensureResponse
    })
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      tabId: 'web-terminal-host-tab',
      leafId: LEAF_ID
    })
    await transport.connect({
      url: '',
      isAccountRestartCurrent: () => true,
      accountRestart: {
        requestId: 'request',
        attemptId: 'attempt',
        hostEpoch: 'host',
        pane: {
          worktreeId: 'repo1::/remote/wt',
          tabId: 'host-tab',
          leafId: LEAF_ID,
          tabCreatedAt: 1
        },
        expected: { kind: 'empty', bindingGeneration: 1 }
      },
      callbacks: {}
    })
    const create = hostRequests.find((r) => r.method === 'terminal.create')
    expect(create?.params).toMatchObject({
      tabId: 'host-tab',
      clientMutationId: 'attempt',
      accountRestart: { requestId: 'request', attemptId: 'attempt' }
    })
    transport.destroy?.()
  })
  it('does not dispatch a restart retired during saved-origin capability negotiation', async () => {
    const negotiation = Promise.withResolvers<unknown>()
    runtimeCall.mockReturnValue(negotiation.promise)
    let current = true
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      tabId: 'tab-1',
      leafId: LEAF_ID
    })
    const pending = transport.connect({
      url: '',
      resumeOrigin: 'saved',
      isAccountRestartCurrent: () => current,
      accountRestart: {
        requestId: 'request',
        attemptId: 'attempt',
        hostEpoch: 'host',
        pane: { worktreeId: 'repo1::/remote/wt', tabId: 'tab-1', leafId: LEAF_ID, tabCreatedAt: 1 },
        expected: { kind: 'empty', bindingGeneration: 1 }
      },
      callbacks: {}
    })
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(expect.objectContaining({ method: 'status.get' }))
    )
    current = false
    negotiation.resolve(okResponse({ capabilities }))
    await pending
    expect(runtimeCall.mock.calls.map(([r]) => r.method)).toEqual(['status.get'])
    expect(transport.getPtyId()).toBeNull()
    transport.destroy?.()
  })
})
