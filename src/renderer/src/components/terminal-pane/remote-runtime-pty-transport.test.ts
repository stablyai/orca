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

describe('createRemoteRuntimePtyTransport', () => {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const subscriptionSendBinary = vi.fn()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  } | null = null

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
    vi.clearAllMocks()
    subscriptionCallbacks = null
    subscriptionSendBinary.mockReset()
    runtimeCall.mockResolvedValue({ ok: true, result: { terminal: { handle: 'terminal-1' } } })
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
    expect(transport.getPtyId()).toBe('remote:terminal-1')
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
      client: { id: 'desktop:tab-1:pane:1', type: 'desktop' },
      viewport: { cols: 120, rows: 40 }
    })
  })

  it('routes encoded restored terminal ids to their owning runtime environment', async () => {
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
        selector: 'env-1',
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

  it('retires stale host-owned terminal handles without surfacing pane errors', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onError = vi.fn()
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-stale',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const { streamId } = latestSubscribePayload()

    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'error', streamId, message: 'terminal_handle_stale' }
    })

    expect(onError).not.toHaveBeenCalled()
    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-stale')
    expect(transport.getPtyId()).toBeNull()
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

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const oldStreamId = latestSubscribePayload().streamId

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-new',
      cols: 80,
      rows: 24,
      callbacks: {}
    })
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: oldStreamId }
    })

    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-new')
    expect(transport.isConnected()).toBe(true)

    await vi.waitFor(() => {
      expect(latestSubscribePayload()).toMatchObject({ terminal: 'terminal-new' })
    })
    const newStreamId = latestSubscribePayload().streamId

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

      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-old',
        cols: 80,
        rows: 24,
        callbacks: {}
      })
      expect(transport.sendInput('queued-for-old')).toBe(true)

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
      .mockResolvedValueOnce(newStream)
    vi.doMock('../../runtime/remote-runtime-terminal-multiplexer', () => ({
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

    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-old',
      cols: 80,
      rows: 24,
      callbacks: { onError }
    })
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

      expect(transport.sendInput('x')).toBe(true)
      vi.advanceTimersByTime(8)

      const inputFrames = subscriptionSendBinary.mock.calls
        .map((call) => decodeTerminalStreamFrame(call[0]))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Input)
      expect(inputFrames).toEqual([])
      expect(runtimeCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'terminal.send',
        params: {
          terminal: 'terminal-new',
          text: 'x',
          client: { id: 'desktop:tab-1:pane:1', type: 'desktop' }
        },
        timeoutMs: 15_000
      })
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
      startupCommandDelivery: 'shell-ready'
    })

    await transport.connect({ url: '', callbacks: {} })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.create',
        params: expect.objectContaining({
          command: "codex 'linked issue context'",
          startupCommandDelivery: 'shell-ready'
        })
      })
    )
  })

  it('prefers connect-time launch metadata when creating the remote runtime terminal', async () => {
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

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'terminal.create',
        params: expect.objectContaining({
          command: "codex '--model' 'gpt-5' 'resume' 'session-1'",
          env: { CODEX_PROFILE: 'captured', ORCA_AGENT_LAUNCH_TOKEN: 'fresh-token' },
          launchConfig: {
            agentArgs: '--model gpt-5',
            agentEnv: { CODEX_PROFILE: 'captured' }
          },
          launchToken: 'fresh-token',
          launchAgent: 'codex'
        })
      })
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
        params: { worktree: 'id:wt-1', tabId: 'host-tab-1', leafId: 'leaf-1' }
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
        params: { worktree: 'id:wt-1', tabId: 'host-tab-1', leafId: 'leaf-2' }
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

  it('does not close a split parent when the requested leaf times out but a sibling is ready', async () => {
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
      await vi.advanceTimersByTimeAsync(15_000)

      await expect(connect).resolves.toBeUndefined()
      expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
      expect(
        runtimeCall.mock.calls.some((call) => call[0].method.startsWith('session.tabs.close'))
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling without closing the host tab when a mirror never publishes a ready handle', async () => {
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
        return Promise.resolve({ ok: true, result: { terminal: { handle: 'duplicate-terminal' } } })
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
      expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
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
        client: { id: 'desktop:tab-1:pane:1', type: 'desktop' }
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
          client: { id: 'desktop:tab-1:pane:1', type: 'desktop' }
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
    expect(onError).toHaveBeenCalledWith(
      'Remote terminal snapshot exceeded the 2 MiB replay limit; live output will continue.'
    )
    expect(onConnect).toHaveBeenCalled()
    expect(onData).toHaveBeenCalledWith('live-after-overflow', expect.objectContaining({ seq: 1 }))
  })
})
