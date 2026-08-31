import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
describe('createRemoteRuntimePtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  } | null = null
  let unsubscribe: {
    unsubscribe: () => void
    sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
  } | null = null
  let unsubscribeFn: ReturnType<typeof vi.fn<() => void>> | null = null

  beforeEach(() => {
    vi.resetModules()
    runtimeCall.mockReset()
    runtimeSubscribe.mockReset()
    subscriptionCallbacks = null
    unsubscribeFn = vi.fn<() => void>()
    unsubscribe = {
      unsubscribe: unsubscribeFn,
      sendBinary: vi.fn()
    }
    runtimeCall.mockImplementation(async (args: { method?: string }) =>
      args.method === 'status.get'
        ? {
            id: 'rpc-status',
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            },
            _meta: { runtimeId: 'runtime-remote' }
          }
        : {
            id: 'rpc-create',
            ok: true,
            result: {
              terminal: {
                handle: 'term-remote',
                worktreeId: 'repo1::/remote/wt',
                title: null,
                surface: 'background'
              }
            },
            _meta: { runtimeId: 'runtime-remote' }
          }
    )
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        queueMicrotask(() => {
          subscriptionCallbacks?.onResponse({
            id: 'rpc-multiplex',
            ok: true,
            result: { type: 'ready' },
            _meta: { runtimeId: 'runtime-remote' }
          })
        })
        return unsubscribe
      }
    )

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        runtimeEnvironments: {
          ...originalWindow?.api?.runtimeEnvironments,
          call: runtimeCall,
          subscribe: runtimeSubscribe
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  function latestRemoteSubscribePayload(): { streamId: number } {
    const send = unsubscribe?.sendBinary as unknown as
      | { mock: { calls: [Uint8Array<ArrayBufferLike>][] } }
      | undefined
    const frames =
      send?.mock.calls
        .map((call) => decodeTerminalStreamFrame(call[0]))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe) ?? []
    const frame = frames.at(-1)
    if (!frame) {
      throw new Error('missing remote terminal subscribe frame')
    }
    const payload = decodeTerminalStreamJson<{ streamId: number }>(frame.payload)
    if (!payload) {
      throw new Error('invalid remote terminal subscribe frame')
    }
    return payload
  }

  it('creates and subscribes to a terminal on the active remote runtime', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onReplayData = vi.fn()
    const onData = vi.fn()
    const onConnect = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: 'claude',
      env: { ORCA_TAB_ID: 'tab-1' },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })

    const result = await transport.connect({
      url: '',
      callbacks: { onReplayData, onData, onConnect }
    })

    expect(result).toEqual({ id: 'remote:env-1@@term-remote', replay: '' })
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.create',
      params: {
        worktree: 'id:repo1::/remote/wt',
        clientMutationId: expect.any(String),
        command: 'claude',
        env: { ORCA_TAB_ID: 'tab-1' },
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111',
        focus: false,
        presentation: 'background'
      },
      timeoutMs: 15_000
    })
    expect(runtimeSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.multiplex',
        params: {}
      }),
      expect.any(Object)
    )
    const { streamId } = latestRemoteSubscribePayload()

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
        payload: encodeTerminalStreamText('hello')
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
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId,
        seq: 4,
        payload: encodeTerminalStreamText(' world')
      })
    )

    expect(onReplayData).toHaveBeenCalledWith('hello')
    expect(onConnect).toHaveBeenCalled()
    expect(onData).toHaveBeenCalledWith(' world', expect.objectContaining({ seq: 4 }))
  })

  it('reports a host stable-pane adoption as reattach without fresh-spawn ownership', async () => {
    runtimeCall.mockResolvedValue({
      id: 'rpc-create',
      ok: true,
      result: {
        terminal: {
          handle: 'term-original',
          worktreeId: 'repo1::/remote/wt',
          title: 'Original',
          surface: 'background',
          isReattach: true
        }
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const onPtySpawn = vi.fn()
    const onReattachDetermined = vi.fn()
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      onPtySpawn
    })

    const result = await transport.connect({
      url: '',
      callbacks: { onReattachDetermined }
    })

    expect(result).toEqual({
      id: 'remote:env-1@@term-original',
      replay: '',
      isReattach: true
    })
    expect(onReattachDetermined).toHaveBeenCalledOnce()
    expect(onPtySpawn).not.toHaveBeenCalled()
  })

  it('does not close an adopted stable-pane owner when create resolves after destroy', async () => {
    let resolveCreate!: (value: unknown) => void
    runtimeCall.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        })
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })

    const connecting = transport.connect({ url: '', callbacks: {} })
    transport.destroy?.()
    resolveCreate({
      id: 'rpc-create',
      ok: true,
      result: {
        terminal: {
          handle: 'term-original',
          worktreeId: 'repo1::/remote/wt',
          title: 'Original',
          surface: 'background',
          isReattach: true
        }
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await connecting

    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.close' })
    )
  })

  it('suspends passive remote output until host sleep is cancelled', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { applyHostWorktreeTerminalSleepState } = await import('./pty-shutdown-exit-deferral')
    const onData = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })
    await transport.connect({ url: '', callbacks: { onData } })
    const { streamId } = latestRemoteSubscribePayload()
    const started = {
      type: 'worktreeTerminalSleepState' as const,
      worktreeId: 'repo1::/remote/wt',
      generation: 7,
      phase: 'started' as const,
      ptyIds: ['host-pty-1'],
      terminalHandles: ['term-remote']
    }

    applyHostWorktreeTerminalSleepState('env-1', started)
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamText('teardown output')
      })
    )
    expect(onData).not.toHaveBeenCalled()

    applyHostWorktreeTerminalSleepState('env-1', { ...started, phase: 'cancelled' })
    expect(onData).toHaveBeenCalledWith('teardown output', expect.objectContaining({ seq: 1 }))
  })

  it('routes provider resumes through the host authority without sending the client command', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: "claude '--resume' 'provider-session'",
      env: { CLIENT_ONLY: 'must-not-cross' },
      launchAgent: 'claude',
      agentArgsOverride: '--permission-mode plan',
      resumeProviderSession: { key: 'session_id', id: 'provider-session' },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.ensureAgentSession',
      params: {
        kind: 'explicit',
        worktree: 'id:repo1::/remote/wt',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'provider-session' },
        agentArgs: '--permission-mode plan',
        placement: {
          tabId: 'tab-1',
          leafId: '11111111-1111-4111-8111-111111111111'
        },
        presentation: 'background'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create',
        params: expect.objectContaining({ command: expect.any(String) })
      })
    )
  })

  it('degrades a Kimi resume to a legacy launch when the host predates the resume capability', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: "kimi '--session' 'session_431324d7'",
      launchAgent: 'kimi',
      resumeProviderSession: { key: 'session_id', id: 'session_431324d7' },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })

    await transport.connect({ url: '', callbacks: {} })

    // Why: the beforeEach host advertises host-authority.v1 but not the Kimi gate, and it answers
    // the widened ensureAgentSession enum with invalid_argument — not a fallback code. Only the
    // per-agent probe keeps the pane alive.
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.ensureAgentSession' })
    )
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create',
        params: expect.objectContaining({ command: "kimi '--session' 'session_431324d7'" })
      })
    )
  })

  it('claims the Kimi provider session on a host that advertises the resume capability', async () => {
    runtimeCall.mockImplementation(async (args: { method?: string }) =>
      args.method === 'status.get'
        ? {
            id: 'rpc-status',
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1', 'agent-session.kimi-resume.v1']
            },
            _meta: { runtimeId: 'runtime-remote' }
          }
        : {
            id: 'rpc-create',
            ok: true,
            result: {
              terminal: {
                handle: 'term-remote',
                worktreeId: 'repo1::/remote/wt',
                title: null,
                surface: 'background'
              }
            },
            _meta: { runtimeId: 'runtime-remote' }
          }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: "kimi '--session' 'session_431324d7'",
      launchAgent: 'kimi',
      resumeProviderSession: { key: 'session_id', id: 'session_431324d7' },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.ensureAgentSession',
        params: expect.objectContaining({
          agent: 'kimi',
          providerSession: { key: 'session_id', id: 'session_431324d7' }
        })
      })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create',
        params: expect.objectContaining({ command: expect.any(String) })
      })
    )
  })

  it('treats an explicitly killed remote session as normal retirement', async () => {
    runtimeCall.mockImplementation(async (args: { method?: string }) =>
      args.method === 'terminal.create'
        ? {
            id: 'rpc-create',
            ok: false,
            error: {
              code: 'terminal_gone',
              message: 'Session "pty-dead" was explicitly killed'
            }
          }
        : {
            id: 'rpc-status',
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt'
    })
    const onError = vi.fn()

    await expect(transport.connect({ url: '', callbacks: { onError } })).resolves.toBeUndefined()
    expect(onError).not.toHaveBeenCalled()
  })

  it('routes fresh agents through an idempotent host-built launch', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: "codex 'fix the race'",
      env: { CLIENT_ONLY: 'must-not-cross' },
      launchAgent: 'codex',
      agentPrompt: 'fix the race',
      agentPromptDelivery: 'draft',
      agentLaunchPreferences: { model: 'gpt-5', effort: 'high' },
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.createAgentSession',
      params: {
        clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
        worktree: 'id:repo1::/remote/wt',
        agent: 'codex',
        prompt: 'fix the race',
        promptDelivery: 'draft',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        placement: {
          tabId: 'tab-1',
          leafId: '11111111-1111-4111-8111-111111111111'
        },
        presentation: 'background'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.create',
        params: expect.objectContaining({ command: expect.any(String) })
      })
    )
  })

  it('forwards input over the stream and disconnects without closing shared remote sessions', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'repo1::/remote/wt',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      await transport.connect({ url: '', callbacks: {} })
      const { streamId } = latestRemoteSubscribePayload()
      runtimeCall.mockClear()
      const send = unsubscribe?.sendBinary as unknown as {
        mockClear: () => void
        mock: { calls: [Uint8Array<ArrayBufferLike>][] }
      }
      send.mockClear()

      expect(transport.sendInput('ls\r')).toBe(true)
      await vi.runOnlyPendingTimersAsync()
      expect(runtimeCall).not.toHaveBeenCalled()
      const inputFrame = decodeTerminalStreamFrame(send.mock.calls[0][0])
      expect(inputFrame?.opcode).toBe(TerminalStreamOpcode.Input)
      expect(inputFrame?.streamId).toBe(streamId)

      transport.disconnect()
      expect(unsubscribeFn).toHaveBeenCalled()
      expect(runtimeCall).not.toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'terminal.close'
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
