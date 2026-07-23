/* eslint-disable max-lines -- Why: remote runtime PTY behavior spans JSON fallback, binary stream, lifecycle, and parser coverage; keeping the matrix together catches transport regressions. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../shared/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import { TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

describe('createRemoteRuntimePtyTransport', () => {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const refreshSessionTabsSnapshot = vi.fn(async () => {})
  const subscriptionSendBinary = vi.fn()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  } | null = null
  let resolvedPaneHandle = 'terminal-1'

  function emitMultiplexReady(): void {
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'ready' }
    })
  }

  function latestSubscribePayload(): {
    streamId: number
    terminal: string
    client: { id: string; type: string }
    viewport?: { cols: number; rows: number }
    capabilities?: { desktopViewportClaims?: 1 }
  } {
    const frames = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe)
    const frame = frames.at(-1)
    if (!frame) {
      throw new Error('missing terminal subscribe frame')
    }
    const payload = decodeTerminalStreamJson<{
      streamId: number
      terminal: string
      client: { id: string; type: string }
      viewport?: { cols: number; rows: number }
      capabilities?: { desktopViewportClaims?: 1 }
    }>(frame.payload)
    if (!payload) {
      throw new Error('invalid terminal subscribe payload')
    }
    return payload
  }

  function emitOutput(streamId: number, data: string): void {
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamText(data)
      })
    )
  }

  function emitSnapshot(streamId: number, data: string): void {
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotStart,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamJson({ kind: 'scrollback' })
      })
    )
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotChunk,
        streamId,
        seq: 2,
        payload: encodeTerminalStreamText(data)
      })
    )
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotEnd,
        streamId,
        seq: 3,
        payload: new Uint8Array()
      })
    )
  }

  function latestFrameForOpcode(opcode: TerminalStreamOpcode) {
    return subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .findLast((frame) => frame?.opcode === opcode)
  }

  function emitSnapshotFrame(
    streamId: number,
    opcode:
      | TerminalStreamOpcode.SnapshotStart
      | TerminalStreamOpcode.SnapshotChunk
      | TerminalStreamOpcode.SnapshotEnd,
    payload: Uint8Array<ArrayBufferLike>
  ): void {
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode,
        streamId,
        seq: 1,
        payload
      })
    )
  }

  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../../runtime/remote-runtime-terminal-multiplexer')
    vi.doMock('@/runtime/web-runtime-session', () => ({
      refreshWebRuntimeSessionTabsSnapshot: refreshSessionTabsSnapshot
    }))
    vi.clearAllMocks()
    subscriptionCallbacks = null
    resolvedPaneHandle = 'terminal-1'
    subscriptionSendBinary.mockReset()
    refreshSessionTabsSnapshot.mockClear()
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'session.tabs.activate') {
        const params = request.params as { tabId: string; leafId?: string }
        const resolvedLeafId = params.leafId ?? 'pane:1'
        return {
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: `${params.tabId}::${resolvedLeafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `${params.tabId}::${resolvedLeafId}`,
                parentTabId: params.tabId,
                leafId: resolvedLeafId,
                title: 'Terminal',
                isActive: true,
                status: 'ready',
                terminal: resolvedPaneHandle
              }
            ]
          }
        }
      }
      if (request.method === 'terminal.resolvePane') {
        const params = request.params as { paneKey: string; worktreeId: string }
        const separator = params.paneKey.indexOf(':')
        const handle = resolvedPaneHandle
        return {
          ok: true,
          result: {
            terminal: {
              handle,
              tabId: params.paneKey.slice(0, separator),
              leafId: params.paneKey.slice(separator + 1),
              worktreeId: params.worktreeId
            }
          }
        }
      }
      return { ok: true, result: { terminal: { handle: 'terminal-1' } } }
    })
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        queueMicrotask(emitMultiplexReady)
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall,
          subscribe: runtimeSubscribe
        }
      }
    })
  })

  it('attaches to an existing remote runtime terminal handle', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:terminal-1',
      cols: 120,
      rows: 40,
      callbacks: { onError }
    })

    await vi.waitFor(() => {
      expect(runtimeSubscribe).toHaveBeenCalled()
    })

    expect(onError).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    expect(transport.getRuntimeEnvironmentId?.()).toBe('env-1')
    await vi.waitFor(() =>
      expect(latestSubscribePayload().capabilities).toEqual({
        ackOutput: 1,
        desktopViewportClaims: 1
      })
    )
    expect(runtimeSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.multiplex',
        params: {}
      }),
      expect.any(Object)
    )
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({
      terminal: 'terminal-1',
      client: { id: expect.stringMatching(/^desktop:tab-1:pane:1:/), type: 'desktop' },
      viewport: { cols: 120, rows: 40 }
    })
  })

  it('does not report attachment health until the authoritative PTY snapshot arrives', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

    transport.attach({ existingPtyId: 'remote:terminal-1', callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    expect(transport.isConnected()).toBe(false)
    emitSnapshot(latestSubscribePayload().streamId, 'authoritative state')
    expect(transport.isConnected()).toBe(true)
    transport.destroy?.()
  })

  it('recovers when the first restored-terminal subscription attempt is offline', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      runtimeSubscribe.mockImplementation(
        async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
          attempt += 1
          if (attempt === 1) {
            throw Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
              code: 'remote_runtime_unavailable'
            })
          }
          subscriptionCallbacks = callbacks
          queueMicrotask(emitMultiplexReady)
          return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
        }
      )
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const onData = vi.fn()
      const recoveryStates: { phase: string; epoch: number; attempt: number }[] = []
      const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

      transport.attach({
        existingPtyId: 'remote:terminal-1',
        callbacks: {
          onData,
          onError,
          onRecoveryStateChange: (state) => recoveryStates.push(state)
        }
      })
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
      const { streamId } = latestSubscribePayload()
      emitSnapshot(streamId, 'restored')
      emitOutput(streamId, 'resumed-output')

      expect(onError).not.toHaveBeenCalled()
      expect(onData).toHaveBeenCalledWith('resumed-output', expect.any(Object))
      expect(transport.sendInputImmediate('resumed-input')).toBe(true)
      expect(transport.isConnected()).toBe(true)
      expect(transport.getRecoveryState?.().phase).toBe('connected')
      expect(recoveryStates.map((state) => state.phase)).toEqual(
        expect.arrayContaining(['connecting', 'recovering', 'connected'])
      )
      const recoveryEpochs = new Set(
        recoveryStates
          .filter((state) => state.phase === 'recovering' || state.phase === 'backoff')
          .map((state) => state.epoch)
      )
      expect(recoveryEpochs.size).toBe(1)
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers when the runtime closes before a restored subscription becomes ready', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      runtimeSubscribe.mockImplementation(
        async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
          attempt += 1
          subscriptionCallbacks = callbacks
          if (attempt === 1) {
            queueMicrotask(() => callbacks.onClose?.())
          } else {
            queueMicrotask(emitMultiplexReady)
          }
          return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
        }
      )
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

      transport.attach({
        existingPtyId: 'remote:terminal-1',
        callbacks: { onError }
      })
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
      const { streamId } = latestSubscribePayload()
      emitSnapshot(streamId, 'restored')

      expect(onError).not.toHaveBeenCalled()
      expect(transport.isConnected()).toBe(true)
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a fatal error during subscription setup exactly once', async () => {
    const unsubscribe = vi.fn()
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
        subscriptionCallbacks = callbacks
        queueMicrotask(() =>
          callbacks.onError?.({
            code: 'unauthorized',
            message: 'Remote Orca runtime rejected the pairing token.'
          })
        )
        return { unsubscribe, sendBinary: subscriptionSendBinary }
      }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

    transport.attach({ existingPtyId: 'remote:terminal-1', callbacks: { onError } })
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    await Promise.resolve()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(transport.getRecoveryState?.().phase).toBe('offline')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
    transport.destroy?.()
  })

  it('retries an unknown terminal-create outcome exactly once with the same mutation id', async () => {
    let createCalls = 0
    runtimeCall.mockImplementation(async (args: { method: string; params?: unknown }) => {
      if (args.method === 'status.get') {
        return {
          ok: true,
          result: { capabilities: [TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] }
        }
      }
      if (args.method === 'terminal.create') {
        createCalls += 1
        if (createCalls === 1) {
          throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
            code: 'runtime_timeout'
          })
        }
        return { ok: true, result: { terminal: { handle: 'terminal-once' } } }
      }
      return { ok: true, result: {} }
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtySpawn = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtySpawn
    })

    await transport.connect({ url: '', callbacks: {} })

    const creates = runtimeCall.mock.calls
      .map(
        ([args]) =>
          args as {
            method: string
            params?: { clientMutationId?: string; reconcileExisting?: boolean }
          }
      )
      .filter((args) => args.method === 'terminal.create')
    expect(creates).toHaveLength(2)
    expect(creates[0].params?.clientMutationId).toMatch(/\S+/)
    expect(creates[1].params?.clientMutationId).toBe(creates[0].params?.clientMutationId)
    expect(creates[0].params?.reconcileExisting).toBeUndefined()
    expect(creates[1].params?.reconcileExisting).toBe(true)
    expect(onPtySpawn).toHaveBeenCalledTimes(1)
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-once')
    transport.destroy?.()
  })

  it('clips a reconciled create timeout to the budget left after a slow capability probe', async () => {
    vi.useFakeTimers()
    try {
      const startedAt = Date.now()
      let createCalls = 0
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'status.get') {
          vi.setSystemTime(startedAt + 59_000)
          return {
            ok: true,
            result: { capabilities: [TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] }
          }
        }
        if (args.method === 'terminal.create') {
          createCalls += 1
          if (createCalls === 1) {
            throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
              code: 'runtime_timeout'
            })
          }
          return { ok: true, result: { terminal: { handle: 'terminal-reconciled' } } }
        }
        return { ok: true, result: {} }
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

      const connect = transport.connect({ url: '', callbacks: {} })
      await vi.advanceTimersByTimeAsync(250)
      await connect

      const createRequests = runtimeCall.mock.calls
        .map(([args]) => args as { method: string; timeoutMs: number })
        .filter((args) => args.method === 'terminal.create')
      expect(createRequests).toHaveLength(2)
      expect(createRequests[1].timeoutMs).toBe(1_000)
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry an unknown create outcome against an older runtime', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        return { ok: true, result: { capabilities: [] } }
      }
      throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
        code: 'runtime_timeout'
      })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

    await transport.connect({ url: '', callbacks: { onError } })

    expect(
      runtimeCall.mock.calls.filter(([args]) => args.method === 'terminal.create')
    ).toHaveLength(1)
    expect(onError).toHaveBeenCalledTimes(1)
    transport.destroy?.()
  })

  it('surfaces an authoritative capability-probe failure after an unknown create outcome', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        throw Object.assign(new Error('Remote runtime pairing credentials expired.'), {
          code: 'unauthorized'
        })
      }
      throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
        code: 'runtime_timeout'
      })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

    await transport.connect({ url: '', callbacks: { onError } })

    expect(onError).toHaveBeenCalledWith('Remote runtime pairing credentials expired.')
    expect(
      runtimeCall.mock.calls.filter(([args]) => args.method === 'terminal.create')
    ).toHaveLength(1)
    transport.destroy?.()
  })

  it('stops unknown terminal-create recovery after one minute and remains manually retryable', async () => {
    vi.useFakeTimers()
    try {
      let reachable = false
      let statusTimesOut = false
      runtimeCall.mockImplementation(async (args: { method: string; timeoutMs: number }) => {
        if (args.method === 'status.get') {
          if (statusTimesOut) {
            return new Promise((_, reject) => {
              setTimeout(() => {
                reject(
                  Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
                    code: 'runtime_timeout'
                  })
                )
              }, args.timeoutMs)
            })
          }
          return {
            ok: true,
            result: { capabilities: [TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] }
          }
        }
        if (args.method === 'terminal.create' && reachable) {
          return { ok: true, result: { terminal: { handle: 'terminal-recovered' } } }
        }
        throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
          code: 'runtime_timeout'
        })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const recoveryStates: string[] = []
      const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })

      const connect = transport.connect({
        url: '',
        callbacks: {
          onError,
          onRecoveryStateChange: (state) => recoveryStates.push(state.phase)
        }
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await connect
      const callsAtCutoff = runtimeCall.mock.calls.length

      expect(onError).not.toHaveBeenCalled()
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      expect(recoveryStates).toContain('recovering')
      expect(runtimeCall.mock.calls.some(([args]) => args.method === 'terminal.create')).toBe(true)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(runtimeCall).toHaveBeenCalledTimes(callsAtCutoff)

      statusTimesOut = true
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)
      const callsAtManualCutoff = runtimeCall.mock.calls.length
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(runtimeCall).toHaveBeenCalledTimes(callsAtManualCutoff)

      statusTimesOut = false
      reachable = true
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.waitFor(() => expect(transport.getPtyId()).toBe('remote:env-1@@terminal-recovered'))
      const createRequests = runtimeCall.mock.calls
        .map(([args]) => args as { method: string; params?: { reconcileExisting?: boolean } })
        .filter((args) => args.method === 'terminal.create')
      expect(createRequests[0].params?.reconcileExisting).toBeUndefined()
      expect(createRequests.slice(1).every((args) => args.params?.reconcileExisting === true)).toBe(
        true
      )
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays an ambiguous structured agent create without downgrading after cutoff', async () => {
    vi.useFakeTimers()
    try {
      let reachable = false
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'status.get') {
          return {
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        }
        if (args.method === 'terminal.createAgentSession' && reachable) {
          return {
            ok: true,
            result: {
              disposition: 'replayed',
              terminal: { handle: 'terminal-agent-recovered' }
            }
          }
        }
        throw Object.assign(new Error('Timed out waiting for the remote Orca runtime.'), {
          code: 'runtime_timeout'
        })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1',
        launchAgent: 'codex'
      })

      const connect = transport.connect({ url: '', callbacks: {} })
      await vi.advanceTimersByTimeAsync(60_000)
      await connect

      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      const initialCreates = runtimeCall.mock.calls
        .map(([args]) => args as { method: string; params?: { clientOperationId?: string } })
        .filter((args) => args.method === 'terminal.createAgentSession')
      expect(initialCreates.length).toBeGreaterThan(0)
      const operationId = initialCreates[0].params?.clientOperationId
      expect(operationId).toMatch(/\S+/)

      reachable = true
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.waitFor(() =>
        expect(transport.getPtyId()).toBe('remote:env-1@@terminal-agent-recovered')
      )

      const allCreates = runtimeCall.mock.calls
        .map(([args]) => args as { method: string; params?: { clientOperationId?: string } })
        .filter((args) => args.method === 'terminal.createAgentSession')
      expect(allCreates.every((args) => args.params?.clientOperationId === operationId)).toBe(true)
      expect(runtimeCall.mock.calls.some(([args]) => args.method === 'terminal.create')).toBe(false)
      expect(runtimeCall.mock.calls.filter(([args]) => args.method === 'status.get')).toHaveLength(
        1
      )
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves web mirrors through host session inventory, not client-side pane aliases', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@stale-client-handle',
      cols: 100,
      rows: 30,
      callbacks: {}
    })

    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({
      terminal: 'terminal-1',
      viewport: { cols: 100, rows: 30 }
    })
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.tabs.activate' })
    )
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.resolvePane',
        params: { paneKey: 'host-tab-1:pane:1', worktreeId: 'wt-1' }
      })
    )
  })

  it('resolves a HUB-native SSH PTY wake hint to its runtime terminal handle', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'terminal.resolvePane') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'hub-terminal-1',
              tabId: 'tab-1',
              leafId,
              ptyId: 'ssh:hub-private@@pty-2',
              worktreeId: 'wt-1',
              executionHostId: 'ssh:hub-private',
              hostPlatform: 'win32'
            }
          }
        }
      }
      throw new Error(`Unexpected method ${request.method}`)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('hub-env', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId
    })

    const result = await transport.connect({
      url: '',
      cols: 120,
      rows: 40,
      sessionId: 'ssh:hub-private@@pty-2',
      callbacks: {}
    })

    expect(result).toEqual({ id: 'remote:hub-env@@hub-terminal-1', replay: '' })
    expect(transport.getPtyId()).toBe('remote:hub-env@@hub-terminal-1')
    expect(transport.getExecutionHostId?.()).toBe('ssh:hub-private')
    expect(transport.getRemotePlatform?.()).toBe('win32')
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'hub-env',
        method: 'terminal.resolvePane',
        params: {
          paneKey: `tab-1:${leafId}`,
          worktreeId: 'wt-1'
        }
      })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'hub-terminal-1' })
  })

  it('verifies a legacy pane response against the requested worktree session', async () => {
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'terminal.resolvePane') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'legacy-terminal-1',
              tabId: 'tab-1',
              leafId: 'pane:1',
              ptyId: 'ssh:hub-private@@pty-2'
            }
          }
        }
      }
      if (request.method === 'session.tabs.list') {
        return {
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'legacy-epoch',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'tab-1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'tab-1::pane:1',
                parentTabId: 'tab-1',
                leafId: 'pane:1',
                title: 'Terminal',
                isActive: true,
                status: 'ready',
                terminal: 'legacy-terminal-1'
              }
            ]
          }
        }
      }
      throw new Error(`Unexpected method ${request.method}`)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('legacy-env', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:legacy-env@@legacy-terminal-1',
      cols: 100,
      rows: 30,
      callbacks: {}
    })

    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    emitSnapshot(latestSubscribePayload().streamId, 'legacy state')
    expect(transport.isConnected()).toBe(true)
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.tabs.list',
        params: { worktree: 'id:wt-1' }
      })
    )
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'legacy-terminal-1' })
  })

  it('rejects a legacy pane handle absent from the requested worktree session', async () => {
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.resolvePane') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'foreign-terminal',
              tabId: 'tab-1',
              leafId: 'pane:1',
              ptyId: 'ssh:hub-private@@foreign-pty'
            }
          }
        }
      }
      if (request.method === 'session.tabs.list') {
        return {
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'legacy-epoch',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'tab-1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'tab-1::pane:1',
                parentTabId: 'tab-1',
                leafId: 'pane:1',
                title: 'Terminal',
                isActive: true,
                status: 'ready',
                terminal: 'worktree-terminal'
              }
            ]
          }
        }
      }
      throw new Error(`Unexpected method ${request.method}`)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('legacy-env', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:legacy-env@@foreign-terminal',
      callbacks: { onError }
    })

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('terminal_owner_mismatch'))
    expect(transport.isConnected()).toBe(false)
    expect(runtimeSubscribe).not.toHaveBeenCalled()
  })

  it('scopes the same legacy handle independently for each runtime environment', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const first = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    const second = createRemoteRuntimePtyTransport('env-2', {
      worktreeId: 'wt-2',
      tabId: 'tab-2',
      leafId: 'leaf-2'
    })

    first.attach({ existingPtyId: 'remote:terminal-1', callbacks: {} })
    second.attach({ existingPtyId: 'remote:terminal-1', callbacks: {} })

    await vi.waitFor(() => {
      expect(first.getPtyId()).toBe('remote:env-1@@terminal-1')
      expect(second.getPtyId()).toBe('remote:env-2@@terminal-1')
    })
  })

  it('parks passive peers when another remote desktop owns the grid', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { getFitOverrideForPty, setFitOverride } =
      await import('@/lib/pane-manager/mobile-fit-overrides')
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })
    await transport.connect({ url: '', cols: 120, rows: 40, callbacks: {} })
    const { streamId } = latestSubscribePayload()
    const ptyId = transport.getPtyId()
    expect(ptyId).not.toBeNull()

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'fit-override-changed',
        streamId,
        mode: 'remote-desktop-fit',
        cols: 96,
        rows: 32
      }
    })

    expect(ptyId ? getFitOverrideForPty(ptyId) : null).toEqual({
      mode: 'remote-desktop-fit',
      cols: 96,
      rows: 32
    })
    if (ptyId) {
      setFitOverride(ptyId, 'desktop-fit', 0, 0)
    }
  })

  it('gives separate paired viewers of the same host pane distinct refresh identities', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const first = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    const second = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    first.attach({ existingPtyId: 'remote:terminal-1', cols: 80, rows: 24, callbacks: {} })
    second.attach({ existingPtyId: 'remote:terminal-1', cols: 120, rows: 40, callbacks: {} })

    await vi.waitFor(() => {
      const subscribeFrames = subscriptionSendBinary.mock.calls
        .map((call) => decodeTerminalStreamFrame(call[0]))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe)
      expect(subscribeFrames).toHaveLength(2)
      const clientIds = subscribeFrames.map((frame) => {
        const payload = frame
          ? decodeTerminalStreamJson<{ client: { id: string } }>(frame.payload)
          : null
        return payload?.client.id
      })
      expect(clientIds[0]).toMatch(/^desktop:tab-1:pane:1:/)
      expect(clientIds[1]).toMatch(/^desktop:tab-1:pane:1:/)
      expect(clientIds[0]).not.toBe(clientIds[1])
    })

    first.destroy?.()
    second.destroy?.()
  })

  it('does not let an encoded restored terminal id override the current worktree owner', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-2', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 120,
      rows: 40,
      callbacks: {}
    })

    await vi.waitFor(() => {
      expect(runtimeSubscribe).toHaveBeenCalled()
    })

    expect(runtimeSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-2',
        method: 'terminal.multiplex'
      }),
      expect.any(Object)
    )
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({
      terminal: 'terminal-1',
      viewport: { cols: 120, rows: 40 }
    })
  })

  it('attaches an environment-scoped handle when an older runtime lacks pane resolution', async () => {
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.resolvePane') {
        return {
          ok: false,
          error: { code: 'method_not_found', message: 'Unknown method: terminal.resolvePane' }
        }
      }
      return { ok: true, result: {} }
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('legacy-env', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:legacy-env@@terminal-legacy',
      cols: 80,
      rows: 24,
      callbacks: {}
    })

    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    emitSnapshot(latestSubscribePayload().streamId, 'legacy state')
    expect(transport.isConnected()).toBe(true)
    expect(transport.getPtyId()).toBe('remote:legacy-env@@terminal-legacy')
    expect(runtimeSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'legacy-env', method: 'terminal.multiplex' }),
      expect.any(Object)
    )
  })

  it('re-derives the host session handle after a transport close instead of resubscribing the stale one', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { getAllOverrides, setFitOverride } =
      await import('@/lib/pane-manager/mobile-fit-overrides')
    const { getAllDrivers, setDriverForPty } =
      await import('@/lib/pane-manager/mobile-driver-state')
    const onPtySpawn = vi.fn()
    const onPtyRebind = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtySpawn,
      onPtyRebind
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-1' })
    setFitOverride('remote:env-1@@terminal-1', 'mobile-fit', 49, 20)
    setDriverForPty('remote:env-1@@terminal-1', { kind: 'mobile', clientId: 'phone-1' })

    // Why: while the tunnel was down the host re-minted this pane's handle;
    // resubscribing the stale closure handle would bind the mirror to a
    // different PTY (#7718). The transport must re-derive from the snapshot.
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list'
        ? {
            ok: true,
            result: {
              worktree: 'wt-1',
              publicationEpoch: 'epoch-1',
              snapshotVersion: 2,
              activeGroupId: null,
              activeTabId: 'tab-1::pane:1',
              activeTabType: 'terminal',
              tabs: [
                {
                  type: 'terminal',
                  id: 'tab-1::pane:1',
                  parentTabId: 'tab-1',
                  leafId: 'pane:1',
                  title: 'Terminal',
                  isActive: true,
                  status: 'ready',
                  terminal: 'terminal-2'
                }
              ]
            }
          }
        : { ok: true, result: {} }
    )
    const subscribeCallsBefore = runtimeSubscribe.mock.calls.length

    // The dedicated multiplex socket dies (liveness/close) → onTransportClose.
    subscriptionCallbacks?.onClose?.()

    await vi.waitFor(() =>
      expect(runtimeSubscribe.mock.calls.length).toBeGreaterThan(subscribeCallsBefore)
    )
    await vi.waitFor(() =>
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-2' })
    )
    expect(transport.getPtyId()).toContain('terminal-2')
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(onPtyRebind).toHaveBeenCalledWith(
      expect.stringContaining('terminal-2'),
      expect.stringContaining('terminal-1')
    )
    expect([...getAllOverrides().keys()]).toEqual(['remote:env-1@@terminal-2'])
    expect([...getAllDrivers().keys()]).toEqual(['remote:env-1@@terminal-2'])
  })

  it('retires the mirror when the host no longer publishes the surface after a transport close', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list'
        ? {
            ok: true,
            result: {
              worktree: 'wt-1',
              publicationEpoch: 'epoch-1',
              snapshotVersion: 2,
              activeGroupId: null,
              activeTabId: null,
              activeTabType: null,
              tabs: []
            }
          }
        : { ok: true, result: {} }
    )

    subscriptionCallbacks?.onClose?.()

    // Why: no red xterm error — retire quietly and let the next session-tabs
    // snapshot drive respawn/removal.
    await vi.waitFor(() => expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1'))
    expect(transport.getPtyId()).toBeNull()
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not close host-owned terminal handles attached from session snapshots', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockClear()

    transport.destroy?.()

    expect(transport.getRecoveryState?.().phase).toBe('disposed')
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.close'
      })
    )
  })

  it('detaches laptop-created remote runtime terminals without closing the server session', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockClear()

    transport.destroy?.()

    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.close'
      })
    )
  })

  it('keeps the regular TUI and draft through inventory failure and stale-handle reconnect', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const onPtySpawn = vi.fn()
    const onPtyRebind = vi.fn()
    const onExit = vi.fn()
    const onDisconnect = vi.fn()
    const renderedScreen: string[] = []
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtyExit,
      onPtySpawn,
      onPtyRebind
    })

    resolvedPaneHandle = 'terminal-stale'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-stale',
      cols: 80,
      rows: 24,
      callbacks: {
        onError,
        onExit,
        onDisconnect,
        onData: (data) => renderedScreen.push(data),
        onReplayData: (data) => renderedScreen.push(data)
      }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const initialStreamId = latestSubscribePayload().streamId
    const draft = 'QA regular reconnect draft - keep this unsent'
    emitOutput(initialStreamId, draft)

    let hostListCalls = 0
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'session.tabs.list') {
        hostListCalls += 1
        if (hostListCalls === 1) {
          throw new Error('runtime reconnect in progress')
        }
        const terminal =
          hostListCalls === 2
            ? 'terminal-stale'
            : hostListCalls === 3
              ? null
              : 'terminal-reconnected'
        return {
          ok: true,
          result: {
            worktree: 'wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: hostListCalls + 1,
            activeGroupId: null,
            activeTabId: 'tab-1::pane:1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'tab-1::pane:1',
                parentTabId: 'tab-1',
                leafId: 'pane:1',
                title: 'Claude Code',
                isActive: true,
                status: terminal ? 'ready' : 'pending-handle',
                terminal
              }
            ]
          }
        }
      }
      return { ok: true, result: {} }
    })

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'error', streamId: initialStreamId, message: 'terminal_handle_stale' }
    })

    await vi.waitFor(() => expect(hostListCalls).toBeGreaterThanOrEqual(1))
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-stale' })
    expect(onPtyExit).not.toHaveBeenCalled()
    await vi.waitFor(
      () => expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-reconnected' }),
      { timeout: 2_000 }
    )
    const replacementStreamId = latestSubscribePayload().streamId
    emitSnapshot(replacementStreamId, draft)

    expect(onError).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(onPtyRebind).toHaveBeenCalledOnce()
    expect(onPtyRebind).toHaveBeenCalledWith(
      'remote:env-1@@terminal-reconnected',
      'remote:env-1@@terminal-stale'
    )
    expect(onExit).not.toHaveBeenCalled()
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-reconnected')
    expect(transport.isConnected()).toBe(true)
    expect(renderedScreen.at(-1)).toBe(draft)
    expect(hostListCalls).toBe(4)
    const subscribedTerminals = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .flatMap((frame) => {
        if (frame?.opcode !== TerminalStreamOpcode.Subscribe) {
          return []
        }
        const payload = decodeTerminalStreamJson<{ terminal: string }>(frame.payload)
        return payload ? [payload.terminal] : []
      })
    expect(subscribedTerminals).toEqual(['terminal-stale', 'terminal-reconnected'])
  })

  it('reattaches from a later host snapshot after bounded replacement polling stops', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const onPtyExit = vi.fn()
      const onPtyRebind = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-tab-1',
        leafId: 'pane:1',
        onPtyExit,
        onPtyRebind
      })

      resolvedPaneHandle = 'terminal-stale'
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-stale',
        cols: 80,
        rows: 24,
        callbacks: { onError }
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

      let hostListCalls = 0
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'terminal.send') {
          return {
            ok: false,
            error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' }
          }
        }
        if (args.method !== 'session.tabs.list') {
          return { ok: true, result: {} }
        }
        hostListCalls += 1
        return {
          ok: true,
          result: {
            worktree: 'wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: hostListCalls + 1,
            activeGroupId: null,
            activeTabId: 'tab-1::pane:1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'tab-1::pane:1',
                parentTabId: 'tab-1',
                leafId: 'pane:1',
                title: 'Claude Code',
                isActive: true,
                status: 'ready',
                terminal: 'terminal-stale'
              }
            ]
          }
        }
      })

      subscriptionCallbacks?.onResponse({
        ok: true,
        result: {
          type: 'error',
          streamId: latestSubscribePayload().streamId,
          message: 'terminal_handle_stale'
        }
      })
      await vi.advanceTimersByTimeAsync(16_000)

      expect(hostListCalls).toBeGreaterThan(1)
      expect(hostListCalls).toBeLessThan(25)
      const listTimeouts = runtimeCall.mock.calls
        .map(([args]) => args)
        .filter((args) => args.method === 'session.tabs.list')
        .map((args) => args.timeoutMs as number)
      expect(listTimeouts[0]).toBe(15_000)
      expect(listTimeouts.every((timeoutMs) => timeoutMs > 0 && timeoutMs <= 15_000)).toBe(true)
      expect(listTimeouts.at(-1)).toBeLessThanOrEqual(1_000)
      expect(onError).not.toHaveBeenCalled()
      expect(onPtyExit).not.toHaveBeenCalled()
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-stale')
      // Cached pixels and a known PTY id do not imply that input/output is attached.
      expect(transport.isConnected()).toBe(false)
      const handleEvents = await import('../../runtime/web-session-terminal-handle-events')
      expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)

      const listCallsAfterBound = hostListCalls
      await expect(transport.sendInputAccepted?.('retry while reconnecting')).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(16_000)

      // The accepted-snapshot listener already owns recovery. User input must
      // not turn a bounded reconnect into recurring host-inventory polling.
      expect(hostListCalls).toBe(listCallsAfterBound)
      expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)

      handleEvents.queueAcceptedWebSessionTerminalSnapshot(
        {
          worktree: 'wt-1',
          publicationEpoch: 'epoch-2',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: 'tab-1::pane:1',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: 'tab-1::pane:1',
              parentTabId: 'tab-1',
              leafId: 'pane:1',
              title: 'Claude Code',
              isActive: true,
              status: 'ready',
              terminal: 'terminal-after-timeout'
            }
          ]
        },
        'env-1'
      )
      await vi.advanceTimersByTimeAsync(0)
      await vi.waitFor(() =>
        expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-after-timeout' })
      )

      expect(onPtyRebind).toHaveBeenCalledWith(
        'remote:env-1@@terminal-after-timeout',
        'remote:env-1@@terminal-stale'
      )
      expect(onPtyExit).not.toHaveBeenCalled()
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-after-timeout')
      expect(transport.isConnected()).toBe(false)
      emitSnapshot(latestSubscribePayload().streamId, 'reattached')
      expect(transport.isConnected()).toBe(true)
      expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
      const subscribedTerminals = subscriptionSendBinary.mock.calls
        .map((call) => decodeTerminalStreamFrame(call[0]))
        .flatMap((frame) => {
          if (frame?.opcode !== TerminalStreamOpcode.Subscribe) {
            return []
          }
          const payload = decodeTerminalStreamJson<{ terminal: string }>(frame.payload)
          return payload ? [payload.terminal] : []
        })
      expect(subscribedTerminals).toEqual(['terminal-stale', 'terminal-after-timeout'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a mounted HUB mirror alive when the old stream ends before the replacement snapshot', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const handleEvents = await import('../../runtime/web-session-terminal-handle-events')
    const onPtyExit = vi.fn()
    const onPtySpawn = vi.fn()
    const onPtyRebind = vi.fn()
    const onExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('hub-env', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1',
      onPtyExit,
      onPtySpawn,
      onPtyRebind
    })

    transport.attach({
      existingPtyId: 'remote:hub-env@@terminal-before-restart',
      cols: 100,
      rows: 30,
      callbacks: { onExit }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const oldStreamId = latestSubscribePayload().streamId

    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.list' ? new Promise(() => {}) : { ok: true, result: {} }
    )
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: oldStreamId, code: 0 }
    })

    expect(onExit).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:hub-env@@terminal-1')
    expect(handleEvents.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)

    handleEvents.queueAcceptedWebSessionTerminalSnapshot(
      {
        worktree: 'wt-1',
        publicationEpoch: 'epoch-after-restart',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: 'host-tab-1::pane:1',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'host-tab-1::pane:1',
            parentTabId: 'host-tab-1',
            leafId: 'pane:1',
            title: 'Terminal',
            isActive: true,
            status: 'ready',
            terminal: 'terminal-after-restart'
          }
        ]
      },
      'hub-env'
    )

    await vi.waitFor(() =>
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-after-restart' })
    )
    expect(transport.getPtyId()).toBe('remote:hub-env@@terminal-after-restart')
    expect(onPtyRebind).toHaveBeenCalledWith(
      'remote:hub-env@@terminal-after-restart',
      'remote:hub-env@@terminal-1'
    )
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('coalesces concurrent stale errors for the handle that was replaced', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    resolvedPaneHandle = 'terminal-stale'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-stale',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    let resolveHostList: (response: unknown) => void = () => {}
    const hostListResponse = new Promise((resolve) => {
      resolveHostList = resolve
    })
    let hostListCalls = 0
    runtimeCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: false,
          error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' }
        })
      }
      if (args.method === 'session.tabs.list') {
        hostListCalls += 1
        return hostListResponse
      }
      return Promise.resolve({ ok: true, result: {} })
    })

    const sendInputAccepted = transport.sendInputAccepted
    if (!sendInputAccepted) {
      throw new Error('Expected acknowledged remote terminal input')
    }
    const sends = Promise.all([sendInputAccepted('first'), sendInputAccepted('second')])
    await vi.waitFor(() => expect(hostListCalls).toBe(1))
    await expect(sends).resolves.toEqual([false, false])

    resolveHostList({
      ok: true,
      result: {
        worktree: 'wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: 'tab-1::pane:1',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'tab-1::pane:1',
            parentTabId: 'tab-1',
            leafId: 'pane:1',
            title: 'Claude Code',
            isActive: true,
            status: 'ready',
            terminal: 'terminal-reconnected'
          }
        ]
      }
    })

    await vi.waitFor(() =>
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-reconnected' })
    )
    await Promise.resolve()

    // Why: the second stale response belonged to terminal-stale. Replaying it
    // against the replacement would add another polling loop and retire it.
    expect(hostListCalls).toBe(1)
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-reconnected')
    expect(transport.isConnected()).toBe(false)
    emitSnapshot(latestSubscribePayload().streamId, 'reattached')
    expect(transport.isConnected()).toBe(true)
  })

  it('still retires the regular TUI surface after an explicit terminal exit', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    resolvedPaneHandle = 'terminal-exited'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-exited',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'error',
        streamId: latestSubscribePayload().streamId,
        message: 'terminal_exited'
      }
    })

    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-exited')
    expect(transport.getPtyId()).toBeNull()
    expect(transport.isConnected()).toBe(false)
    expect(transport.getRecoveryState?.().phase).toBe('ended')
  })

  it('asks the HUB to recover an expired SSH pane and rebinds the host identity', async () => {
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const onPtyRebind = vi.fn()
    resolvedPaneHandle = 'terminal-expired'
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('hub-env', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1',
      onPtyExit,
      onPtyRebind
    })
    transport.attach({
      existingPtyId: 'remote:hub-env@@terminal-expired',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.recoverPane') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'terminal-replacement',
              tabId: 'host-tab-1',
              leafId: 'pane:1',
              ptyId: 'ssh-private-pty',
              worktreeId: 'wt-1'
            }
          }
        }
      }
      return { ok: true, result: {} }
    })

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'error',
        streamId: latestSubscribePayload().streamId,
        message: 'SSH_SESSION_EXPIRED: relay identity changed'
      }
    })

    await vi.waitFor(() =>
      expect(transport.getPtyId()).toBe('remote:hub-env@@terminal-replacement')
    )
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'hub-env',
      method: 'terminal.recoverPane',
      params: {
        paneKey: 'host-tab-1:pane:1',
        worktreeId: 'wt-1',
        expectedTerminal: 'terminal-expired'
      },
      timeoutMs: 15_000
    })
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-replacement' })
    expect(onPtyRebind).toHaveBeenCalledWith(
      'remote:hub-env@@terminal-replacement',
      'remote:hub-env@@terminal-expired'
    )
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('fails closed when an older HUB cannot recover an expired SSH pane', async () => {
    const onError = vi.fn()
    resolvedPaneHandle = 'terminal-expired'
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('legacy-hub', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })
    transport.attach({
      existingPtyId: 'remote:legacy-hub@@terminal-expired',
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.recoverPane') {
        return {
          ok: false,
          error: { code: 'method_not_found', message: 'Unknown method: terminal.recoverPane' }
        }
      }
      return { ok: true, result: {} }
    })

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: {
        type: 'error',
        streamId: latestSubscribePayload().streamId,
        message: 'SSH_SESSION_EXPIRED: relay identity changed'
      }
    })

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Unknown method: terminal.recoverPane')
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
    expect(transport.getPtyId()).toBe('remote:legacy-hub@@terminal-expired')
    expect(transport.isConnected()).toBe(false)
  })

  it('ignores stale stream end after reattaching a newer remote terminal', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    resolvedPaneHandle = 'terminal-old'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const oldStreamId = latestSubscribePayload().streamId
    const oldSubscriptionCallbacks = subscriptionCallbacks

    resolvedPaneHandle = 'terminal-new'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-new',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => {
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-new')
    })
    oldSubscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: oldStreamId }
    })

    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-new')
    expect(transport.isConnected()).toBe(false)

    await vi.waitFor(() => {
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-new' })
    })
    const newStreamId = latestSubscribePayload().streamId
    emitSnapshot(newStreamId, 'reattached')
    expect(transport.isConnected()).toBe(true)

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: newStreamId }
    })

    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-new')
    expect(transport.getPtyId()).toBeNull()
    expect(transport.isConnected()).toBe(false)
  })

  it('drops pending input when attaching a different remote terminal handle', async () => {
    vi.useFakeTimers()
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      resolvedPaneHandle = 'terminal-old'
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-old',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      await vi.waitFor(() => expect(transport.getPtyId()).toBe('remote:env-1@@terminal-old'))
      expect(transport.sendInput('queued-for-old')).toBe(true)

      resolvedPaneHandle = 'terminal-new'
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-new',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      runtimeCall.mockClear()

      await vi.advanceTimersByTimeAsync(10)

      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'terminal.send'
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores stale attach subscription rejection after reattaching a newer remote terminal', async () => {
    const oldSubscription = {
      reject: null as ((error: Error) => void) | null
    }
    const newStream = {
      streamId: 2,
      sendInput: vi.fn(() => true),
      resize: vi.fn(() => true),
      serializeBuffer: vi.fn(async () => null),
      close: vi.fn()
    }
    const subscribeTerminal = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            oldSubscription.reject = reject
          })
      )
      .mockImplementationOnce(async (args: { callbacks: { onSubscribed?: () => void } }) => {
        args.callbacks.onSubscribed?.()
        return newStream
      })
    vi.doMock('../../runtime/remote-runtime-terminal-multiplexer', () => ({
      REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE: 'remote_terminal_snapshot_too_large',
      getRemoteRuntimeTerminalMultiplexer: vi.fn(() => ({ subscribeTerminal }))
    }))
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    resolvedPaneHandle = 'terminal-old'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscribeTerminal).toHaveBeenCalledOnce())
    resolvedPaneHandle = 'terminal-new'
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-new',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscribeTerminal).toHaveBeenCalledTimes(2))

    oldSubscription.reject?.(new Error('terminal_handle_stale'))
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-new')
    expect(transport.isConnected()).toBe(true)
  })

  it('does not send queued input through a stale stream during remote handle replacement', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())

    vi.useFakeTimers()
    try {
      subscriptionSendBinary.mockClear()
      runtimeCall.mockClear()

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-new',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      subscriptionSendBinary.mockClear()

      // Why: replacement input stays disabled until terminal.resolvePane proves the new handle belongs to this pane.
      expect(transport.sendInput('x')).toBe(false)
      vi.advanceTimersByTime(8)

      const inputFrames = subscriptionSendBinary.mock.calls
        .map((call) => decodeTerminalStreamFrame(call[0]))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Input)
      expect(inputFrames).toEqual([])
      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.send' })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a remote terminal created after the pane was destroyed', async () => {
    let resolveCreate: (value: unknown) => void = () => {}
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return new Promise((resolve) => {
          resolveCreate = resolve
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    transport.destroy?.()
    resolveCreate({ ok: true, result: { terminal: { handle: 'terminal-late' } } })
    await connect

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.close',
      params: { terminal: 'terminal-late' },
      timeoutMs: 15_000
    })
  })

  it('cannot let a stale create completion replace a newer attached terminal', async () => {
    let resolveCreate: (value: unknown) => void = () => {}
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return new Promise((resolve) => {
          resolveCreate = resolve
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtySpawn = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      onPtySpawn
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    transport.attach({ existingPtyId: 'remote:env-2@@terminal-attached', callbacks: {} })
    resolveCreate({ ok: true, result: { terminal: { handle: 'terminal-late' } } })
    await connect

    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-attached')
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.close',
      params: { terminal: 'terminal-late' },
      timeoutMs: 15_000
    })
    transport.destroy?.()
  })

  it('does not close a live owner adopted after provisional pane handoff', async () => {
    let resolveEnsure: (value: unknown) => void = () => {}
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'status.get') {
        return Promise.resolve({
          ok: true,
          result: {
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        })
      }
      if (args.method === 'terminal.ensureAgentSession') {
        return new Promise((resolve) => {
          resolveEnsure = resolve
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      launchAgent: 'codex',
      resumeProviderSession: { key: 'session_id', id: 'live-session' }
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.ensureAgentSession' })
      )
    )
    transport.destroy?.()
    resolveEnsure({
      ok: true,
      result: {
        disposition: 'adopted',
        terminal: { handle: 'terminal-live', worktreeId: 'wt-1', title: null }
      }
    })
    await connect

    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.close' })
    )
  })

  it('does not close a structured create after provisional pane handoff', async () => {
    let resolveCreate: (value: unknown) => void = () => {}
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'status.get') {
        return Promise.resolve({
          ok: true,
          result: {
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        })
      }
      if (args.method === 'terminal.createAgentSession') {
        return new Promise((resolve) => {
          resolveCreate = resolve
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'provisional-tab',
      leafId: 'provisional-leaf',
      launchAgent: 'codex'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.createAgentSession' })
      )
    )
    transport.destroy?.()
    resolveCreate({
      ok: true,
      result: {
        disposition: 'created',
        terminal: {
          handle: 'terminal-live',
          tabId: 'canonical-host-tab',
          leafId: 'canonical-host-leaf'
        }
      }
    })
    await connect

    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.close' })
    )
  })

  it('passes activation intent when creating the remote runtime terminal', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      activate: true
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.create',
        params: expect.objectContaining({
          tabId: 'tab-1',
          leafId: 'pane:1',
          focus: false,
          presentation: 'background',
          activate: true
        })
      })
    )
  })

  it('scopes ephemeral setup terminals to the floating-terminal selector (#6789)', async () => {
    const { brandEphemeralSetupTerminalWorktreeId } =
      await import('../../../../shared/ephemeral-setup-terminal-worktree-id')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: brandEphemeralSetupTerminalWorktreeId(
        'feature-wall-orchestration-skill-terminal'
      ),
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.create',
        params: expect.objectContaining({
          worktree: 'id:global-floating-terminal'
        })
      })
    )
  })

  it('passes startup command delivery when creating the remote runtime terminal', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      command: "codex 'linked issue context'",
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
      startupCommandDelivery: 'shell-ready',
      terminalColorQueryReplies: { foreground: '#ffffff', background: '#282c34' }
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.create',
        params: expect.objectContaining({
          command: "codex 'linked issue context'",
          envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
          startupCommandDelivery: 'shell-ready',
          terminalColorQueryReplies: { foreground: '#ffffff', background: '#282c34' }
        })
      })
    )
  })

  it('uses connect-time agent identity while the remote host builds the launch', async () => {
    runtimeCall.mockImplementation(async (args: { method?: string }) =>
      args.method === 'status.get'
        ? {
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        : { ok: true, result: { terminal: { handle: 'terminal-1' } } }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      command: "codex 'old'",
      launchConfig: { agentArgs: '--old', agentEnv: {} },
      agentArgsOverride: '--profile captured',
      launchToken: 'old-token',
      launchAgent: 'codex'
    })

    await transport.connect({
      url: '',
      command: "codex '--model' 'gpt-5' 'resume' 'session-1'",
      env: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'fresh-token' },
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      launchToken: 'fresh-token',
      launchAgent: 'codex',
      resumeProviderSession: {
        key: 'session_id',
        id: 'session-1',
        transcriptPath: '/home/example/.codex/sessions/2026/07/20/rollout-a.jsonl'
      },
      callbacks: {}
    })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.ensureAgentSession',
        params: expect.objectContaining({
          kind: 'explicit',
          worktree: 'id:wt-1',
          agent: 'codex',
          providerSession: {
            key: 'session_id',
            id: 'session-1',
            transcriptPath: '/home/example/.codex/sessions/2026/07/20/rollout-a.jsonl'
          },
          agentArgs: '--profile captured',
          placement: { tabId: 'tab-1', leafId: 'pane:1' },
          presentation: 'background'
        })
      })
    )
  })

  it('records the exact provisional handoff and refreshes a snapshot that arrived early', async () => {
    runtimeCall.mockImplementation(async (args: { method?: string }) =>
      args.method === 'status.get'
        ? {
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        : {
            ok: true,
            result: {
              disposition: 'created',
              terminal: {
                handle: 'terminal-1',
                tabId: 'canonical-host-tab',
                leafId: 'canonical-host-leaf'
              }
            }
          }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { resolveWebAgentSessionHandoff } =
      await import('../../runtime/web-agent-session-handoff')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'provisional-tab',
      leafId: 'provisional-leaf',
      launchAgent: 'codex'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(
      resolveWebAgentSessionHandoff({
        environmentId: 'env-1',
        worktreeId: 'wt-1',
        provisionalTabId: 'provisional-tab'
      })
    ).toBe('canonical-host-tab')
    expect(refreshSessionTabsSnapshot).toHaveBeenCalledWith('env-1', 'wt-1', {
      acceptCurrentSnapshot: true,
      confirmAgentSessionHandoff: {
        provisionalTabId: 'provisional-tab',
        hostTabId: 'canonical-host-tab',
        hostTerminalHandle: 'terminal-1'
      }
    })
  })

  it('preserves the connect-time legacy payload when host authority is unavailable', async () => {
    runtimeCall.mockImplementation(async (args: { method?: string }) =>
      args.method === 'status.get'
        ? {
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: []
            }
          }
        : { ok: true, result: { terminal: { handle: 'terminal-legacy' } } }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      command: "codex 'old'",
      launchConfig: { agentArgs: '--old', agentEnv: {} },
      launchToken: 'old-token',
      launchAgent: 'codex'
    })

    await transport.connect({
      url: '',
      command: "codex '--model' 'gpt-5' 'resume' 'session-1'",
      env: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'fresh-token' },
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      launchToken: 'fresh-token',
      launchAgent: 'codex',
      callbacks: {}
    })

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.create',
      params: {
        worktree: 'id:wt-1',
        clientMutationId: expect.any(String),
        command: "codex '--model' 'gpt-5' 'resume' 'session-1'",
        env: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'fresh-token' },
        launchConfig: {
          agentArgs: '--model gpt-5',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        launchToken: 'fresh-token',
        launchAgent: 'codex',
        tabId: 'tab-1',
        leafId: 'pane:1',
        focus: false,
        presentation: 'background'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.createAgentSession' })
    )
  })

  it('activates pending host session mirrors instead of creating duplicate terminals', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'session.tabs.activate') {
        return Promise.resolve({
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'host-tab-1::leaf-1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-1',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-1',
                title: 'Terminal 1',
                isActive: true,
                status: 'pending-handle',
                terminal: null
              }
            ]
          }
        })
      }
      if (args.method === 'session.tabs.list') {
        return Promise.resolve({
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 2,
            activeGroupId: 'group-1',
            activeTabId: 'host-tab-1::leaf-1',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-1',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-1',
                title: 'Terminal 1',
                isActive: true,
                status: 'ready',
                terminal: 'terminal-1'
              }
            ]
          }
        })
      }
      return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const result = await transport.connect({ url: '', callbacks: {} })

    expect(result).toEqual({ id: 'remote:env-1@@terminal-1', replay: '' })
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.tabs.activate',
        params: {
          worktree: 'id:wt-1',
          tabId: 'host-tab-1',
          leafId: 'leaf-1',
          notifyClients: false,
          navigation: 'caller'
        }
      })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create'
      })
    )
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload()).toMatchObject({
      terminal: 'terminal-1',
      viewport: { cols: 80, rows: 24 }
    })
  })

  it('retires a host mirror that is authoritatively absent', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'session.tabs.activate') {
        return { ok: false, error: { code: 'runtime_error', message: 'tab_not_found' } }
      }
      if (args.method === 'terminal.recoverPane') {
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'terminal-created-on-hub',
              tabId: 'host-tab-1',
              leafId: 'leaf-1',
              ptyId: 'ssh-private-pty',
              worktreeId: 'wt-1'
            }
          }
        }
      }
      return { ok: true, result: {} }
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('hub-env', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const onError = vi.fn()
    await expect(transport.connect({ url: '', callbacks: { onError } })).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.recoverPane' })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
  })

  it('activates the requested split leaf for pending host session mirrors', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'session.tabs.activate') {
        return Promise.resolve({
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'host-tab-1::leaf-2',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-1',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-1',
                title: 'Terminal 1',
                isActive: false,
                status: 'pending-handle',
                terminal: null
              },
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-2',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-2',
                title: 'Terminal 2',
                isActive: true,
                status: 'pending-handle',
                terminal: null
              }
            ]
          }
        })
      }
      if (args.method === 'session.tabs.list') {
        return Promise.resolve({
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 2,
            activeGroupId: 'group-1',
            activeTabId: 'host-tab-1::leaf-2',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-1',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-1',
                title: 'Terminal 1',
                isActive: false,
                status: 'ready',
                terminal: 'terminal-1'
              },
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-2',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-2',
                title: 'Terminal 2',
                isActive: true,
                status: 'ready',
                terminal: 'terminal-2'
              }
            ]
          }
        })
      }
      return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-2'
    })

    const result = await transport.connect({ url: '', callbacks: {} })

    expect(result).toEqual({ id: 'remote:env-1@@terminal-2', replay: '' })
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.tabs.activate',
        params: {
          worktree: 'id:wt-1',
          tabId: 'host-tab-1',
          leafId: 'leaf-2',
          notifyClients: false,
          navigation: 'caller'
        }
      })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create'
      })
    )
  })

  it('does not attach a pending split leaf to a ready sibling', async () => {
    let listCount = 0
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'session.tabs.activate') {
        return Promise.resolve({
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: 'host-tab-1::leaf-2',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-1',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-1',
                title: 'Terminal 1',
                isActive: true,
                status: 'ready',
                terminal: 'terminal-1'
              },
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-2',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-2',
                title: 'Terminal 2',
                isActive: false,
                status: 'pending-handle',
                terminal: null
              }
            ]
          }
        })
      }
      if (args.method === 'session.tabs.list') {
        listCount += 1
        return Promise.resolve({
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: listCount + 1,
            activeGroupId: 'group-1',
            activeTabId: 'host-tab-1::leaf-2',
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-1',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-1',
                title: 'Terminal 1',
                isActive: false,
                status: 'ready',
                terminal: 'terminal-1'
              },
              {
                type: 'terminal',
                id: 'host-tab-1::leaf-2',
                parentTabId: 'host-tab-1',
                leafId: 'leaf-2',
                title: 'Terminal 2',
                isActive: true,
                status: 'ready',
                terminal: 'terminal-2'
              }
            ]
          }
        })
      }
      return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-2'
    })

    const result = await transport.connect({ url: '', callbacks: {} })

    expect(result).toEqual({ id: 'remote:env-1@@terminal-2', replay: '' })
    expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-2' })
  })

  it('stops polling when a requested split leaf disappears but siblings remain', async () => {
    vi.useFakeTimers()
    try {
      runtimeCall.mockImplementation((args) => {
        if (args.method === 'session.tabs.activate') {
          return Promise.resolve({
            ok: true,
            result: {
              worktree: 'id:wt-1',
              publicationEpoch: 'epoch-1',
              snapshotVersion: 1,
              activeGroupId: 'group-1',
              activeTabId: 'host-tab-1::leaf-2',
              activeTabType: 'terminal',
              tabs: [
                {
                  type: 'terminal',
                  id: 'host-tab-1::leaf-1',
                  parentTabId: 'host-tab-1',
                  leafId: 'leaf-1',
                  title: 'Terminal 1',
                  isActive: false,
                  status: 'ready',
                  terminal: 'terminal-1'
                },
                {
                  type: 'terminal',
                  id: 'host-tab-1::leaf-2',
                  parentTabId: 'host-tab-1',
                  leafId: 'leaf-2',
                  title: 'Terminal 2',
                  isActive: true,
                  status: 'pending-handle',
                  terminal: null
                }
              ]
            }
          })
        }
        if (args.method === 'session.tabs.list') {
          return Promise.resolve({
            ok: true,
            result: {
              worktree: 'id:wt-1',
              publicationEpoch: 'epoch-1',
              snapshotVersion: 2,
              activeGroupId: 'group-1',
              activeTabId: 'host-tab-1::leaf-1',
              activeTabType: 'terminal',
              tabs: [
                {
                  type: 'terminal',
                  id: 'host-tab-1::leaf-1',
                  parentTabId: 'host-tab-1',
                  leafId: 'leaf-1',
                  title: 'Terminal 1',
                  isActive: true,
                  status: 'ready',
                  terminal: 'terminal-1'
                }
              ]
            }
          })
        }
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'leaf-2'
      })

      const connect = transport.connect({ url: '', callbacks: { onError } })
      await vi.advanceTimersByTimeAsync(150)

      await expect(connect).resolves.toBeUndefined()
      expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
      expect(
        runtimeCall.mock.calls.filter((call) => call[0].method === 'session.tabs.list')
      ).toHaveLength(1)
      await Promise.resolve()
      await Promise.resolve()
      expect(
        runtimeCall.mock.calls.some((call) => call[0].method.startsWith('session.tabs.close'))
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a timed-out pending split untouched without closing its parent', async () => {
    vi.useFakeTimers()
    try {
      const splitSnapshot = {
        worktree: 'id:wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: 'host-tab-1::leaf-2',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'host-tab-1::leaf-1',
            parentTabId: 'host-tab-1',
            leafId: 'leaf-1',
            title: 'Terminal 1',
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'terminal',
            id: 'host-tab-1::leaf-2',
            parentTabId: 'host-tab-1',
            leafId: 'leaf-2',
            title: 'Terminal 2',
            isActive: true,
            status: 'pending-handle',
            terminal: null
          }
        ]
      }
      runtimeCall.mockImplementation((args) => {
        if (args.method === 'session.tabs.activate' || args.method === 'session.tabs.list') {
          return Promise.resolve({ ok: true, result: splitSnapshot })
        }
        return Promise.resolve({
          ok: true,
          result: {
            terminal: {
              handle: 'terminal-2',
              tabId: 'host-tab-1',
              leafId: 'leaf-2',
              worktreeId: 'wt-1'
            }
          }
        })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'leaf-2'
      })

      const connect = transport.connect({ url: '', callbacks: { onError } })
      await vi.advanceTimersByTimeAsync(15_000)

      await expect(connect).resolves.toBeUndefined()
      expect(onError).not.toHaveBeenCalled()
      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.recoverPane' })
      )
      expect(
        runtimeCall.mock.calls.some((call) => call[0].method.startsWith('session.tabs.close'))
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not mutate a mirror whose handle readiness remains unknown', async () => {
    vi.useFakeTimers()
    try {
      const pendingSnapshot = {
        worktree: 'id:wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: 'host-tab-1::leaf-1',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'host-tab-1::leaf-1',
            parentTabId: 'host-tab-1',
            leafId: 'leaf-1',
            title: 'Terminal 1',
            isActive: true,
            status: 'pending-handle',
            terminal: null
          }
        ]
      }
      runtimeCall.mockImplementation((args) => {
        if (args.method === 'session.tabs.activate' || args.method === 'session.tabs.list') {
          return Promise.resolve({ ok: true, result: pendingSnapshot })
        }
        return Promise.resolve({
          ok: true,
          result: {
            terminal: {
              handle: 'terminal-resolved',
              tabId: 'host-tab-1',
              leafId: 'leaf-1',
              worktreeId: 'wt-1'
            }
          }
        })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'leaf-1'
      })

      const connect = transport.connect({ url: '', callbacks: { onError } })
      await vi.advanceTimersByTimeAsync(15_000)

      await expect(connect).resolves.toBeUndefined()
      expect(onError).not.toHaveBeenCalled()
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'session.tabs.activate' })
      )
      const listCalls = runtimeCall.mock.calls.filter(
        (call) => call[0].method === 'session.tabs.list'
      )
      expect(listCalls.length).toBeGreaterThan(0)
      expect(listCalls.length).toBeLessThanOrEqual(101)
      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'terminal.create'
        })
      )
      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.recoverPane' })
      )
      const closeCalls = runtimeCall.mock.calls.filter((call) =>
        String(call[0].method).startsWith('session.tabs.close')
      )
      expect(closeCalls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('unsubscribes a remote terminal subscription that resolves after destroy', async () => {
    let resolveSubscribe: (value: {
      unsubscribe: () => void
      sendBinary: typeof subscriptionSendBinary
    }) => void = () => {}
    const unsubscribe = vi.fn()
    runtimeSubscribe.mockImplementation(
      (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return new Promise<{ unsubscribe: () => void; sendBinary: typeof subscriptionSendBinary }>(
          (resolve) => {
            resolveSubscribe = (value) => {
              resolve(value)
              queueMicrotask(emitMultiplexReady)
            }
          }
        )
      }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    const connect = transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => {
      expect(runtimeSubscribe).toHaveBeenCalled()
    })
    transport.destroy?.()
    resolveSubscribe({ unsubscribe, sendBinary: subscriptionSendBinary })
    await connect

    expect(unsubscribe).toHaveBeenCalled()
    expect(transport.getPtyId()).toBeNull()
  })

  it('delivers cleaned remote data before deferred title, bell, and OSC 9999 handlers', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onData = vi.fn()
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentStatus = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      onTitleChange,
      onBell,
      onAgentStatus
    })

    await transport.connect({ url: '', callbacks: { onData } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitOutput(
      streamId,
      'before\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07after\x1b]0;. Claude working\x07\x07'
    )

    expect(onData).toHaveBeenCalledWith(
      'beforeafter\x1b]0;. Claude working\x07\x07',
      expect.objectContaining({ seq: 1 })
    )
    await vi.waitFor(() =>
      expect(onAgentStatus).toHaveBeenCalledWith({
        state: 'working',
        prompt: 'ship it',
        agentType: 'codex'
      })
    )
    expect(onTitleChange).toHaveBeenCalledWith('. Claude working', '. Claude working')
    expect(onBell).toHaveBeenCalledTimes(1)
  })

  it('processes binary remote data chunks through the terminal parser', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onData = vi.fn()
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentStatus = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      onTitleChange,
      onBell,
      onAgentStatus
    })

    await transport.connect({ url: '', callbacks: { onData } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitOutput(
      streamId,
      'before\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07after'
    )

    expect(onData).toHaveBeenCalledWith('beforeafter', expect.objectContaining({ seq: 1 }))
    await vi.waitFor(() =>
      expect(onAgentStatus).toHaveBeenCalledWith({
        state: 'working',
        prompt: 'ship it',
        agentType: 'codex'
      })
    )
  })

  it('resubscribes without surfacing a PTY error when the remote runtime subscription closes', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onExit = vi.fn()
    const onDisconnect = vi.fn()
    const onPtyExit = vi.fn()
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    await transport.connect({ url: '', callbacks: { onExit, onDisconnect, onError } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    subscriptionCallbacks?.onClose?.()

    expect(onExit).not.toHaveBeenCalled()
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
  })

  it('keeps retrying when the first post-partition terminal reattach fails', async () => {
    let subscribeAttempt = 0
    const recoveryPhases: string[] = []
    const transportCallbacks: NonNullable<typeof subscriptionCallbacks>[] = []
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
        subscribeAttempt += 1
        transportCallbacks.push(callbacks)
        subscriptionCallbacks = callbacks
        if (subscribeAttempt === 2) {
          throw new Error('Could not connect to the remote Orca runtime.')
        }
        queueMicrotask(emitMultiplexReady)
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({
      url: '',
      callbacks: {
        onError,
        onRecoveryStateChange: (state) => recoveryPhases.push(state.phase)
      }
    })
    transportCallbacks[0].onError?.({
      code: 'remote_runtime_unavailable',
      message: 'Remote Orca runtime stopped responding; the stream connection was reset.'
    })

    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(3))
    expect(onError).not.toHaveBeenCalled()
    expect(recoveryPhases).toContain('backoff')
    transport.destroy?.()
  })

  it('surfaces fatal transport errors once without retrying or double-unsubscribing', async () => {
    const unsubscribe = vi.fn()
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
        subscriptionCallbacks = callbacks
        queueMicrotask(emitMultiplexReady)
        return { unsubscribe, sendBinary: subscriptionSendBinary }
      }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1' })
    await transport.connect({ url: '', callbacks: { onError } })

    subscriptionCallbacks?.onError?.({
      code: 'unauthorized',
      message: 'Remote Orca runtime rejected the pairing token.'
    })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
    expect(transport.isConnected()).toBe(false)
    transport.destroy?.()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('recovers repeated partitions without changing PTY identity or accepting detached input', async () => {
    const callbacksByEpoch: NonNullable<typeof subscriptionCallbacks>[] = []
    const unsubscribeByEpoch: ReturnType<typeof vi.fn>[] = []
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
        callbacksByEpoch.push(callbacks)
        subscriptionCallbacks = callbacks
        const unsubscribe = vi.fn()
        unsubscribeByEpoch.push(unsubscribe)
        queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
        return { unsubscribe, sendBinary: subscriptionSendBinary }
      }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onData = vi.fn()
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: { onData, onError } })
    const ptyId = transport.getPtyId()

    for (let cycle = 0; cycle < 10; cycle += 1) {
      callbacksByEpoch.at(-1)?.onError?.({
        code: 'remote_runtime_unavailable',
        message: 'Remote runtime connection closed.'
      })

      expect(transport.isConnected()).toBe(false)
      expect(transport.sendInput(`detached-${cycle}`)).toBe(false)
      expect(unsubscribeByEpoch[cycle]).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(cycle + 2))
      await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
      const { streamId } = latestSubscribePayload()
      expect(transport.isConnected()).toBe(false)
      emitSnapshot(streamId, `snapshot-${cycle}`)
      await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
      emitOutput(streamId, `output-${cycle}`)
      expect(transport.sendInputImmediate(`input-${cycle}`)).toBe(true)

      expect(transport.getPtyId()).toBe(ptyId)
      expect(onData).toHaveBeenCalledWith(`output-${cycle}`, expect.any(Object))
      expect(
        decodeTerminalStreamText(
          latestFrameForOpcode(TerminalStreamOpcode.Input)?.payload ?? new Uint8Array()
        )
      ).toBe(`input-${cycle}`)
      expect(callbacksByEpoch).toHaveLength(cycle + 2)
    }

    expect(onError).not.toHaveBeenCalled()
    expect(runtimeSubscribe).toHaveBeenCalledTimes(11)
    transport.destroy?.()
    expect(unsubscribeByEpoch.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(
      true
    )
  })

  it('stops automatic retries and manually reattaches the same PTY in a new epoch', async () => {
    vi.useFakeTimers()
    try {
      let partitioned = false
      const callbacksByConnection: NonNullable<typeof subscriptionCallbacks>[] = []
      runtimeSubscribe.mockImplementation(
        async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
          if (partitioned) {
            throw Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
              code: 'remote_runtime_unavailable'
            })
          }
          callbacksByConnection.push(callbacks)
          subscriptionCallbacks = callbacks
          queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
          return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
        }
      )
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const recoveryStates: { phase: string; epoch: number; attempt: number }[] = []
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        callbacks: {
          onError,
          onRecoveryStateChange: (state) => recoveryStates.push(state)
        }
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      emitSnapshot(latestSubscribePayload().streamId, 'before partition')
      expect(transport.isConnected()).toBe(true)

      partitioned = true
      callbacksByConnection[0].onClose?.()
      await vi.advanceTimersByTimeAsync(60_000)

      const disconnectedState = transport.getRecoveryState?.()
      const callsAtCutoff = runtimeSubscribe.mock.calls.length
      expect(disconnectedState?.phase).toBe('disconnected')
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
      expect(transport.isConnected()).toBe(false)
      expect(transport.sendInput('must not reach a stale socket')).toBe(false)
      expect(onError).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(runtimeSubscribe).toHaveBeenCalledTimes(callsAtCutoff)

      partitioned = false
      expect(transport.retryRecovery?.()).toBe(true)
      expect(transport.retryRecovery?.()).toBe(false)
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(callsAtCutoff + 1))
      await vi.waitFor(() => {
        const subscribeFrames = subscriptionSendBinary.mock.calls
          .map((call) => decodeTerminalStreamFrame(call[0]))
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe)
        expect(subscribeFrames).toHaveLength(2)
      })
      const manualStream = latestSubscribePayload()
      expect(manualStream.terminal).toBe('terminal-1')
      emitSnapshot(manualStream.streamId, 'after manual reconnect')

      expect(transport.isConnected()).toBe(true)
      expect(transport.getRecoveryState?.().phase).toBe('connected')
      expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
      expect(recoveryStates.at(-1)?.epoch).toBeGreaterThan(disconnectedState?.epoch ?? 0)
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases pending claimed input when reconnect subscription fails', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    await transport.connect({ url: '', callbacks: { onError } })
    let rejectReconnect = (_error: Error): void => {}
    runtimeSubscribe.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectReconnect = reject
        })
    )

    subscriptionCallbacks?.onClose?.()
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    expect(transport.claimViewport?.(101, 33)).toBe(true)
    const accepted = transport.sendInputAccepted?.('\x03')
    await Promise.resolve()
    rejectReconnect(new Error('reconnect failed'))

    await expect(accepted).resolves.toBe(false)
    expect(onError).toHaveBeenCalledWith('reconnect failed')
  })

  it('releases pending claimed input when the remote terminal ends', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    await transport.connect({ url: '', callbacks: {} })
    const { streamId } = latestSubscribePayload()

    expect(transport.claimViewport?.(101, 33)).toBe(true)
    const accepted = transport.sendInputAccepted?.('x')
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId }
    })

    await expect(accepted).resolves.toBe(false)
  })

  it('retries when a replacement transport closes before its stream installs', async () => {
    const transportCallbacks: NonNullable<typeof subscriptionCallbacks>[] = []
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
        transportCallbacks.push(callbacks)
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    const connected = transport.connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(transportCallbacks).toHaveLength(1))
    transportCallbacks[0].onResponse({ ok: true, result: { type: 'ready' } })
    await connected

    transportCallbacks[0].onClose?.()
    await vi.waitFor(() => expect(transportCallbacks).toHaveLength(2))
    transportCallbacks[1].onResponse({ ok: true, result: { type: 'ready' } })
    transportCallbacks[1].onClose?.()

    await vi.waitFor(() => expect(transportCallbacks).toHaveLength(3))
    transport.destroy?.()
  })

  it('resubscribes with the latest pane viewport after the remote stream closes', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', cols: 80, rows: 24, callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    expect(latestSubscribePayload().viewport).toEqual({ cols: 80, rows: 24 })

    expect(transport.resize(132, 43)).toBe(true)
    subscriptionCallbacks?.onClose?.()

    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => {
      expect(latestSubscribePayload().viewport).toEqual({ cols: 132, rows: 43 })
    })
  })

  it('replays a viewport that changed during the subscribe round-trip once the stream is current', async () => {
    // Why: a resize landing while the subscribe is in flight takes the one-shot
    // RPC fallback, which is refresh-only (no leak) and no-ops before the stream
    // floor exists. The transport must replay the latest viewport over the
    // now-current stream so the PTY does not stall at the subscribe-time width.
    // Hold the multiplex "ready" to keep the round-trip open across the resize.
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    // Drain microtasks WITHOUT advancing timers, so the 33ms viewport batcher
    // cannot fire — the replayed Resize frame must come from the round-trip
    // flush alone (this test fails if that flush is removed).
    const flushMicrotasks = async (): Promise<void> => {
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve()
      }
    }

    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    transport.attach({
      existingPtyId: 'remote:terminal-1',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())

    // Resize while the stream is not yet current (subscribe still pending).
    expect(transport.resize(132, 43)).toBe(true)

    // Release readiness and drain the resolution chain by microtasks only.
    emitMultiplexReady()
    await flushMicrotasks()

    // The Subscribe frame still carries the subscribe-time viewport...
    expect(latestSubscribePayload().viewport).toEqual({ cols: 80, rows: 24 })
    // ...and the newer viewport is replayed as a Resize frame over the stream,
    // before the batcher's 33ms timer could have produced it.
    const resizeFrame = latestFrameForOpcode(TerminalStreamOpcode.Resize)
    expect(resizeFrame && decodeTerminalStreamJson(resizeFrame.payload)).toEqual({
      cols: 132,
      rows: 43
    })

    transport.destroy?.()
  })

  it('replays a claim before input typed during the subscribe round-trip', async () => {
    vi.useFakeTimers()
    try {
      runtimeSubscribe.mockImplementation(
        async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
          subscriptionCallbacks = callbacks
          return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
        }
      )
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({
        existingPtyId: 'remote:terminal-1',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalled())
      expect(transport.claimViewport?.(101, 33)).toBe(true)
      expect(transport.sendInput('x')).toBe(true)
      await vi.advanceTimersByTimeAsync(8)
      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.send' })
      )

      emitMultiplexReady()
      await vi.waitFor(() => {
        const opcodes = subscriptionSendBinary.mock.calls
          .map((call) => decodeTerminalStreamFrame(call[0])?.opcode)
          .filter((opcode) => opcode !== undefined)
        expect(opcodes).toEqual([
          TerminalStreamOpcode.Subscribe,
          TerminalStreamOpcode.ClaimViewport,
          TerminalStreamOpcode.Resize,
          TerminalStreamOpcode.Input
        ])
      })
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces rapid remote terminal input before sending it to the runtime', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('a')).toBe(true)
      expect(transport.sendInput('b')).toBe(true)
      expect(runtimeCall).not.toHaveBeenCalled()

      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      const frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe('ab')
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends coalesced terminal input as binary frames once the stream is established', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('a')).toBe(true)
      expect(transport.sendInput('b')).toBe(true)
      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      const frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe('ab')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not coalesce large remote terminal input chunks above the terminal ceiling', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      const chunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
      expect(transport.sendInput(chunk)).toBe(true)
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      let frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe(chunk)

      expect(transport.sendInput('tail')).toBe(true)
      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(2)
      frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[1][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe('tail')
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns runtime acceptance for acknowledged terminal input', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: true,
          result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 1 } }
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    await expect(transport.sendInputAccepted?.('\x03')).resolves.toBe(true)
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.send',
      params: {
        terminal: 'terminal-1',
        text: '\x03',
        client: { id: expect.stringMatching(/^desktop:tab-1:pane:1:/), type: 'desktop' },
        viewport: { cols: 80, rows: 24 },
        claimViewport: true
      },
      timeoutMs: 15_000
    })
  })

  it('preserves queued remote input order before acknowledged terminal input', async () => {
    vi.useFakeTimers()
    try {
      runtimeCall.mockImplementation((args) => {
        if (args.method === 'terminal.create') {
          return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
        }
        if (args.method === 'terminal.send') {
          return Promise.resolve({
            ok: true,
            result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 2 } }
          })
        }
        return Promise.resolve({ ok: true, result: {} })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('a')).toBe(true)
      await expect(transport.sendInputAccepted?.('\x03')).resolves.toBe(true)
      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'terminal.send',
        params: {
          terminal: 'terminal-1',
          text: 'a\x03',
          client: { id: expect.stringMatching(/^desktop:tab-1:pane:1:/), type: 'desktop' },
          viewport: { cols: 80, rows: 24 },
          claimViewport: true
        },
        timeoutMs: 15_000
      })
      expect(subscriptionSendBinary).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns false when acknowledged terminal input is rejected by the runtime', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: true,
          result: { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } }
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    await expect(transport.sendInputAccepted?.('\x03')).resolves.toBe(false)
  })

  it('splits large acknowledged remote input before terminal.send RPCs', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: true,
          result: {
            send: {
              handle: 'terminal-1',
              accepted: true,
              bytesWritten: args.params.text.length
            }
          }
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    const chunk = '😀'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES / 4)
    await expect(transport.sendInputAccepted?.(`${chunk}tail`)).resolves.toBe(true)

    const sendCalls = runtimeCall.mock.calls.filter((call) => call[0].method === 'terminal.send')
    expect(sendCalls).toHaveLength(2)
    expect(sendCalls[0]?.[0].params.text).toBe(chunk)
    expect(sendCalls[1]?.[0].params.text).toBe('tail')
  })

  it('yields while validating accepted large acknowledged remote input before terminal.send RPCs', async () => {
    vi.useFakeTimers()
    try {
      runtimeCall.mockImplementation((args) => {
        if (args.method === 'terminal.create') {
          return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
        }
        if (args.method === 'terminal.send') {
          return Promise.resolve({
            ok: true,
            result: {
              send: {
                handle: 'terminal-1',
                accepted: true,
                bytesWritten: args.params.text.length
              }
            }
          })
        }
        return Promise.resolve({ ok: true, result: {} })
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })
      const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

      await transport.connect({ url: '', callbacks: {} })
      runtimeCall.mockClear()

      const accepted = transport.sendInputAccepted?.(text)
      await Promise.resolve()

      expect(runtimeCall).not.toHaveBeenCalled()

      await vi.runAllTimersAsync()

      await expect(accepted).resolves.toBe(true)
      const sendTexts = runtimeCall.mock.calls
        .filter((call) => call[0].method === 'terminal.send')
        .map((call) => call[0].params.text)
      expect(sendTexts.join('')).toBe(text)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops large acknowledged remote input after a rejected chunk', async () => {
    const firstChunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
    const rejectedChunk = `tail${'y'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES - 4)}`
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      if (args.method === 'terminal.send') {
        return Promise.resolve({
          ok: true,
          result: {
            send: {
              handle: 'terminal-1',
              accepted: args.params.text !== rejectedChunk,
              bytesWritten: args.params.text === rejectedChunk ? 0 : args.params.text.length
            }
          }
        })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })

    await expect(transport.sendInputAccepted?.(`${firstChunk}${rejectedChunk}after`)).resolves.toBe(
      false
    )

    const sendTexts = runtimeCall.mock.calls
      .filter((call) => call[0].method === 'terminal.send')
      .map((call) => call[0].params.text)
    expect(sendTexts).toEqual([firstChunk, rejectedChunk])
  })

  it('rejects oversized acknowledged remote input before runtime RPCs', async () => {
    runtimeCall.mockImplementation((args) => {
      if (args.method === 'terminal.create') {
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: {} })
    runtimeCall.mockClear()

    await expect(
      transport.sendInputAccepted?.('😀'.repeat(Math.floor(TERMINAL_INPUT_MAX_BYTES / 4) + 1))
    ).resolves.toBe(false)
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('preserves literal LF input when sending remote PTY binary frames', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      expect(transport.sendInput('echo one\necho two\r\n')).toBe(true)
      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      const frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamText(frame.payload) : '').toBe('echo one\necho two\r\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces rapid remote viewport updates before sending the latest size', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      runtimeCall.mockClear()
      subscriptionSendBinary.mockClear()

      expect(transport.resize(80, 24)).toBe(true)
      expect(transport.resize(120, 40)).toBe(true)
      expect(runtimeCall).not.toHaveBeenCalled()

      await vi.runOnlyPendingTimersAsync()

      expect(runtimeCall).not.toHaveBeenCalled()
      expect(subscriptionSendBinary).toHaveBeenCalledTimes(1)
      const frame = decodeTerminalStreamFrame(subscriptionSendBinary.mock.calls[0][0])
      expect(frame?.opcode).toBe(TerminalStreamOpcode.Resize)
      expect(frame?.streamId).toBe(streamId)
      expect(frame ? decodeTerminalStreamJson(frame.payload) : null).toEqual({
        cols: 120,
        rows: 40
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends an activity claim before the user input it sizes', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestSubscribePayload()
      subscriptionSendBinary.mockClear()

      expect(transport.claimViewport?.(101, 33)).toBe(true)
      expect(transport.sendInput('x')).toBe(true)
      await vi.runOnlyPendingTimersAsync()

      const frames = subscriptionSendBinary.mock.calls.map((call) =>
        decodeTerminalStreamFrame(call[0])
      )
      expect(frames.map((frame) => frame?.opcode)).toEqual([
        TerminalStreamOpcode.ClaimViewport,
        TerminalStreamOpcode.Resize,
        TerminalStreamOpcode.Input
      ])
      expect(frames[0]?.streamId).toBe(streamId)
      expect(frames[0] ? decodeTerminalStreamJson(frames[0].payload) : null).toEqual({
        cols: 101,
        rows: 33
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays remote scrollback through the parser without firing stale attention events', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentStatus = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      onTitleChange,
      onBell,
      onAgentStatus
    })

    await transport.connect({ url: '', callbacks: { onReplayData } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitSnapshot(
      streamId,
      'before\x1b]9999;{"state":"working","prompt":"old","agentType":"codex"}\x07after\x1b]0;Remote title\x07\x07'
    )

    expect(onReplayData).toHaveBeenCalledWith('beforeafter\x1b]0;Remote title\x07\x07')
    await vi.waitFor(() =>
      expect(onTitleChange).toHaveBeenCalledWith('Remote title', 'Remote title')
    )
    expect(onAgentStatus).not.toHaveBeenCalled()
    expect(onBell).not.toHaveBeenCalled()
  })

  it('replays binary snapshot chunks without firing stale attention events', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentStatus = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      onTitleChange,
      onBell,
      onAgentStatus
    })

    await transport.connect({ url: '', callbacks: { onReplayData, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitSnapshot(
      streamId,
      'before\x1b]9999;{"state":"working","prompt":"old","agentType":"codex"}\x07after'
    )

    expect(onReplayData).toHaveBeenCalledWith('beforeafter')
    expect(onAgentStatus).not.toHaveBeenCalled()
    expect(onBell).not.toHaveBeenCalled()
    expect(onConnect).toHaveBeenCalled()
  })

  it('resolves explicit binary snapshot requests without replaying into xterm', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onData = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1'
    })

    await transport.connect({ url: '', callbacks: { onReplayData, onData, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()
    emitSnapshot(streamId, 'initial')
    expect(onReplayData).toHaveBeenCalledWith('initial')
    expect(onConnect).toHaveBeenCalled()

    const snapshotPromise = transport.serializeBuffer?.({ scrollbackRows: 5000 })
    const snapshotRequestFrame = latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)
    const snapshotRequestPayload = snapshotRequestFrame
      ? decodeTerminalStreamJson<{ requestId?: number; scrollbackRows?: number }>(
          snapshotRequestFrame.payload
        )
      : null
    expect(snapshotRequestFrame?.streamId).toBe(streamId)
    expect(snapshotRequestPayload).toMatchObject({ requestId: 1, scrollbackRows: 5000 })

    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        kind: 'scrollback',
        requestId: snapshotRequestPayload?.requestId,
        cols: 132,
        rows: 43,
        seq: 17,
        source: 'headless'
      })
    )
    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotChunk,
      encodeTerminalStreamText('requested snapshot')
    )
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())

    await expect(snapshotPromise).resolves.toEqual({
      data: 'requested snapshot',
      cols: 132,
      rows: 43,
      seq: 17,
      source: 'headless'
    })
    expect(onReplayData).toHaveBeenCalledTimes(1)
    expect(onData).not.toHaveBeenCalledWith('requested snapshot', expect.anything())
  })

  it('keeps initial replay separate from in-flight explicit binary snapshot requests', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1'
    })

    await transport.connect({ url: '', callbacks: { onReplayData, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()

    const snapshotPromise = transport.serializeBuffer?.({ scrollbackRows: 5000 })
    const snapshotRequestFrame = latestFrameForOpcode(TerminalStreamOpcode.SnapshotRequest)
    const snapshotRequestPayload = snapshotRequestFrame
      ? decodeTerminalStreamJson<{ requestId?: number }>(snapshotRequestFrame.payload)
      : null
    expect(snapshotRequestPayload?.requestId).toBe(1)

    emitSnapshot(streamId, 'initial replay')
    expect(onReplayData).toHaveBeenCalledWith('initial replay')
    expect(onConnect).toHaveBeenCalled()

    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        kind: 'scrollback',
        requestId: snapshotRequestPayload?.requestId,
        cols: 100,
        rows: 20
      })
    )
    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotChunk,
      encodeTerminalStreamText('requested replay')
    )
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())

    await expect(snapshotPromise).resolves.toEqual({
      data: 'requested replay',
      cols: 100,
      rows: 20,
      seq: undefined,
      source: undefined
    })
    expect(onReplayData).toHaveBeenCalledTimes(1)
  })

  it('bounds oversized binary snapshots without closing the live stream', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onData = vi.fn()
    const onError = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1'
    })

    await transport.connect({ url: '', callbacks: { onReplayData, onData, onError, onConnect } })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()

    emitSnapshotFrame(
      streamId,
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({ kind: 'scrollback' })
    )
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotChunk, new Uint8Array(1024 * 1024))
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotChunk, new Uint8Array(1024 * 1024))
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotChunk, new Uint8Array(1))
    emitSnapshotFrame(streamId, TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
    emitOutput(streamId, 'live-after-overflow')

    expect(onReplayData).not.toHaveBeenCalled()
    // Why: an oversized snapshot is skipped but live output continues, so the
    // transport classifies it as benign and never surfaces a fatal red banner.
    expect(onError).not.toHaveBeenCalled()
    expect(onConnect).toHaveBeenCalled()
    expect(onData).toHaveBeenCalledWith('live-after-overflow', expect.objectContaining({ seq: 1 }))
  })
})
