import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, runtimeSubscribe, latestSubscribePayload, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => subscriptionCallbacks,
    setCallbacks: (callbacks) => {
      subscriptionCallbacks = callbacks
    },
    getResolvedPaneHandle: () => resolvedPaneHandle,
    setResolvedPaneHandle: (handle) => {
      resolvedPaneHandle = handle
    }
  })

const HOST_TARGET = { targetWorktreeSelector: 'path:/srv/project', projectHostSetupId: 'setup-b' }
const LEAF = '11111111-1111-4111-8111-111111111111'

type RuntimeCallRequest = { method: string; params?: unknown }

function isRuntimeCallRequest(value: unknown): value is RuntimeCallRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    typeof value.method === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requests(): RuntimeCallRequest[] {
  return runtimeCall.mock.calls.map(([request]) => {
    if (!isRuntimeCallRequest(request)) {
      throw new Error('malformed runtime call observed')
    }
    return request
  })
}

function methods(): string[] {
  return requests().map((request) => request.method)
}

function createParams(): Record<string, unknown> | undefined {
  const create = requests().find((request) => request.method === 'terminal.create')
  if (create === undefined) {
    return undefined
  }
  if (!isRecord(create.params)) {
    throw new Error('terminal.create carried no params record')
  }
  return create.params
}

async function createTransport(hostTerminalTarget?: typeof HOST_TARGET, launchAgent?: 'codex') {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  return createRemoteRuntimePtyTransport('env-b', {
    worktreeId: 'wt-local',
    tabId: 'local-tab',
    leafId: LEAF,
    ...(hostTerminalTarget ? { hostTerminalTarget } : {}),
    ...(launchAgent ? { launchAgent } : {})
  })
}

describe('remote runtime transport for a host-stamped terminal', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
    // Why: the target never saw the local tab/leaf, so its pane registry answers "not found".
    runtimeCall.mockImplementation(async (request: { method: string }) =>
      request.method === 'terminal.resolvePane' || request.method === 'terminal.recoverPane'
        ? { ok: false, error: { code: 'terminal_not_found', message: 'terminal_not_found' } }
        : { ok: true, result: { terminal: { handle: 'created-1' } } }
    )
  })

  it('adopts the returned PTY handle without local graph identity or a fresh spawn', async () => {
    const transport = await createTransport(HOST_TARGET)
    const onError = vi.fn()

    transport.attach({
      existingPtyId: 'remote:env-b@@handle-1',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })

    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())
    await vi.waitFor(() => expect(latestSubscribePayload()).toMatchObject({ terminal: 'handle-1' }))
    expect(transport.getPtyId()).toBe('remote:env-b@@handle-1')
    expect(onError).not.toHaveBeenCalled()
    expect(methods()).not.toContain('terminal.resolvePane')
    expect(methods()).not.toContain('terminal.create')
  })

  it('shows recovery while its host is offline, then reattaches the same handle when it is ready', async () => {
    vi.useFakeTimers()
    try {
      const healthySubscribe = runtimeSubscribe.getMockImplementation()
      runtimeSubscribe.mockImplementation(() =>
        Promise.reject(
          Object.assign(new Error('Remote Orca runtime closed the connection.'), {
            code: 'remote_runtime_unavailable'
          })
        )
      )
      const phases: string[] = []
      const transport = await createTransport(HOST_TARGET)
      transport.attach({
        existingPtyId: 'remote:env-b@@handle-1',
        callbacks: { onRecoveryStateChange: (state) => phases.push(state.phase) }
      })
      await vi.advanceTimersByTimeAsync(250)
      // The phase the pane's reconnect banner renders from.
      expect(phases.some((phase) => phase !== 'idle')).toBe(true)
      const attemptsWhileOffline = runtimeSubscribe.mock.calls.length

      runtimeSubscribe.mockImplementation(healthySubscribe!)
      // What the host's control connection turning ready does, on the transport's own registry.
      const { reviveRemoteRuntimePtyRecoveriesForEnvironment } =
        await import('./remote-runtime-pty-recovery-state')
      expect(reviveRemoteRuntimePtyRecoveriesForEnvironment('env-b')).toBe(1)
      await vi.advanceTimersByTimeAsync(250)
      expect(runtimeSubscribe.mock.calls.length).toBeGreaterThan(attemptsWhileOffline)
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'handle-1' })
      expect(methods()).not.toContain('terminal.create')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('legacy attach still consults the host pane registry (contrast)', async () => {
    const transport = await createTransport()
    transport.attach({
      existingPtyId: 'remote:env-b@@handle-1',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(methods()).toContain('terminal.resolvePane'))
  })

  it.each([
    ['another host', 'remote:env-c@@handle-1'],
    ['no owner', 'remote:handle-1']
  ])('refuses a PTY owned by %s without adopting or spawning', async (_label, existingPtyId) => {
    const transport = await createTransport(HOST_TARGET)
    const onError = vi.fn()

    transport.attach({ existingPtyId, cols: 80, rows: 24, callbacks: { onError } })

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Remote terminal belongs to a different host.')
    )
    expect(runtimeSubscribe).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBeNull()
    expect(methods()).toEqual([])
  })

  it.each([
    ['remote:env-b@@handle-1', 'owned'],
    ['remote:env-c@@handle-1', 'foreign'],
    ['remote:handle-1', 'ownerless']
  ])('routes a saved handle by its owner: %s', async (sessionId, owner) => {
    const transport = await createTransport(HOST_TARGET)
    const onError = vi.fn()
    const onRecoveryStateChange = vi.fn()
    try {
      const result = await transport.connect({
        url: '',
        sessionId,
        cols: 80,
        rows: 24,
        callbacks: { onError, onRecoveryStateChange }
      })

      if (owner === 'owned') {
        expect(result).toMatchObject({ id: sessionId, isReattach: true })
        expect(latestSubscribePayload()).toMatchObject({ terminal: 'handle-1' })
        expect(onError).not.toHaveBeenCalled()
      } else if (owner === 'ownerless') {
        expect(result).toMatchObject({ id: 'remote:env-b@@created-1' })
        expect(latestSubscribePayload()).toMatchObject({ terminal: 'created-1' })
        expect(createParams()).toMatchObject({ worktree: 'path:/srv/project' })
        expect(onError).not.toHaveBeenCalled()
      } else {
        expect(result).toBeUndefined()
        expect(transport.getPtyId()).toBeNull()
        expect(runtimeSubscribe).not.toHaveBeenCalled()
        expect(onError).toHaveBeenCalledWith('Remote terminal belongs to a different host.')
        expect(onRecoveryStateChange).toHaveBeenLastCalledWith(
          expect.objectContaining({ phase: 'offline' })
        )
      }
      expect(methods()).not.toContain('terminal.resolvePane')
      if (owner !== 'ownerless') {
        expect(methods()).not.toContain('terminal.create')
      }
    } finally {
      transport.destroy?.()
    }
  })

  it('creates on the target setup folder without local tab or leaf ids', async () => {
    const transport = await createTransport(HOST_TARGET)
    await transport.connect({ url: '', cols: 80, rows: 24, callbacks: {} })

    const params = createParams()
    expect(params).toMatchObject({ worktree: 'path:/srv/project', presentation: 'background' })
    expect(params?.tabId).toBeUndefined()
    expect(params?.leafId).toBeUndefined()
    expect(JSON.stringify(params)).not.toContain('wt-local')
  })

  it('refuses an agent launch instead of starting it under the source worktree', async () => {
    const transport = await createTransport(HOST_TARGET, 'codex')
    const onError = vi.fn()
    await transport.connect({ url: '', cols: 80, rows: 24, callbacks: { onError } })

    expect(onError).toHaveBeenCalledWith('Starting an agent on another host is not supported yet.')
    expect(methods()).toEqual([])
  })

  it('keeps legacy create params unchanged', async () => {
    const transport = await createTransport()
    await transport.connect({ url: '', cols: 80, rows: 24, callbacks: {} })

    expect(createParams()).toMatchObject({
      worktree: 'id:wt-local',
      tabId: 'local-tab',
      leafId: LEAF
    })
  })
})
