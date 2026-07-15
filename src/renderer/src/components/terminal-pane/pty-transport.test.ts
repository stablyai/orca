/* oxlint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import { createTerminalSessionStateSaveFailureMessage } from '../../../../shared/terminal-session-state-save-failure'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../shared/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null
  let onReplay: ((payload: { id: string; data: string }) => void) | null = null
  let onExit: ((payload: { id: string; code: number }) => void) | null = null

  function flushPtySideEffects(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  beforeEach(() => {
    vi.resetModules()
    onData = null
    onReplay = null
    onExit = null

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
          write: vi.fn(),
          writeAccepted: vi.fn().mockResolvedValue(true),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onReplay: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onReplay = callback
            return () => {}
          }),
          onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
            onExit = callback
            return () => {}
          })
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

  it('leaves title tracking to the PTY data stream (no OpenCode IPC channel)', async () => {
    // Why: the dedicated OpenCode status IPC channel was replaced by the
    // unified agent-hooks server; the transport layer no longer has a
    // per-agent status callback. Keep the smoke test so the transport
    // still wires up onData/onExit handlers on a basic connect.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})

    await transport.connect({ url: '', callbacks: {} })

    expect(onData).not.toBeNull()
    expect(onExit).not.toBeNull()
    transport.disconnect()
  })

  it('leaves the transport silently unbound after a failed connect — sendInput drops with no write IPC (frozen-terminal repro)', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const write = window.api.pty.write as unknown as ReturnType<typeof vi.fn>
    const transport = createIpcPtyTransport({})

    // Generic spawn failure (e.g. daemon not ready during a startup restore):
    // the error IS surfaced via onError, but the transport stays unbound and
    // every later keystroke is dropped with no further signal.
    spawn.mockRejectedValueOnce(new Error('daemon socket not ready'))
    const onError = vi.fn()
    await transport.connect({ url: '', callbacks: { onError } })
    expect(onError).toHaveBeenCalled()
    expect(transport.isConnected()).toBe(false)
    expect(transport.sendInput('echo hello\r')).toBe(false)
    await flushPtySideEffects()
    expect(write).not.toHaveBeenCalled()

    // The tombstoned-session rejection is swallowed with NO callback at all —
    // a restored pane that hits it renders persisted content while eating
    // keystrokes with zero user-visible signal (Discord #performance / #2836).
    spawn.mockRejectedValueOnce(new Error('TerminalKilledError: session xyz was explicitly killed'))
    const onErrorKilled = vi.fn()
    await transport.connect({ url: '', callbacks: { onError: onErrorKilled } })
    expect(onErrorKilled).not.toHaveBeenCalled()
    expect(transport.isConnected()).toBe(false)
    expect(transport.sendInput('echo hello\r')).toBe(false)
    await flushPtySideEffects()
    expect(write).not.toHaveBeenCalled()
  })

  it('ignores a stale exit for a previous PTY after reconnecting the same transport', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const onPtyExit = vi.fn()
    spawn.mockResolvedValueOnce({ id: 'pty-old' }).mockResolvedValueOnce({ id: 'pty-new' })

    const transport = createIpcPtyTransport({ onPtyExit })

    await transport.connect({ url: '', callbacks: {} })
    await transport.connect({ url: '', callbacks: {} })

    onExit?.({ id: 'pty-old', code: 0 })

    expect(onPtyExit).not.toHaveBeenCalledWith('pty-old')
    expect(transport.getPtyId()).toBe('pty-new')
    expect(transport.isConnected()).toBe(true)

    onExit?.({ id: 'pty-new', code: 0 })

    expect(onPtyExit).toHaveBeenCalledWith('pty-new')
    expect(transport.getPtyId()).toBeNull()
    expect(transport.isConnected()).toBe(false)
  })

  it('ignores stale data and replay for a previous PTY after reconnecting the same transport', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const onDataCallback = vi.fn()
    const onReplayData = vi.fn()
    spawn.mockResolvedValueOnce({ id: 'pty-old' }).mockResolvedValueOnce({ id: 'pty-new' })

    const transport = createIpcPtyTransport({})

    await transport.connect({
      url: '',
      callbacks: { onData: vi.fn(), onReplayData: vi.fn() }
    })
    await transport.connect({
      url: '',
      callbacks: { onData: onDataCallback, onReplayData }
    })

    onData?.({ id: 'pty-old', data: 'old data' })
    onReplay?.({ id: 'pty-old', data: 'old replay' })

    expect(onDataCallback).not.toHaveBeenCalled()
    expect(onReplayData).not.toHaveBeenCalled()

    onData?.({ id: 'pty-new', data: 'new data' })
    onReplay?.({ id: 'pty-new', data: 'new replay' })

    expect(onDataCallback).toHaveBeenCalledWith('new data')
    expect(onReplayData).toHaveBeenCalledWith('new replay')
  })

  it('keeps the live handler when detach() runs after a newer transport attached to the same PTY', async () => {
    // Why: pane->tab detach and split-group moves rehome the React subtree, so
    // the NEW TerminalPane can attach to the same ptyId BEFORE the old pane's
    // unmount detach() runs. An unconditional unregister deletes the live
    // handler and the pane freezes with the PTY still alive (frozen-pane bug).
    const { createIpcPtyTransport } = await import('./pty-transport')
    const receivedByNewPane = vi.fn()
    const replayedToNewPane = vi.fn()
    const exitSeenByNewPane = vi.fn()
    const receivedByOldPane = vi.fn()

    const oldPane = createIpcPtyTransport({})
    await oldPane.connect({ url: '', callbacks: { onData: receivedByOldPane } })

    const newPane = createIpcPtyTransport({})
    newPane.attach?.({
      existingPtyId: 'pty-1',
      callbacks: {
        onData: receivedByNewPane,
        onReplayData: replayedToNewPane,
        onExit: exitSeenByNewPane
      }
    })
    oldPane.detach?.()

    onData?.({ id: 'pty-1', data: 'live output' })
    onReplay?.({ id: 'pty-1', data: 'replay output' })

    expect(receivedByNewPane).toHaveBeenCalledWith('live output')
    expect(replayedToNewPane).toHaveBeenCalledWith('replay output')
    expect(receivedByOldPane).not.toHaveBeenCalled()

    onExit?.({ id: 'pty-1', code: 0 })
    expect(exitSeenByNewPane).toHaveBeenCalledWith(0)
  })

  it('buffers data across a normal detach-then-attach gap and drains it to the next pane', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const receivedByNewPane = vi.fn()

    const oldPane = createIpcPtyTransport({})
    await oldPane.connect({ url: '', callbacks: { onData: vi.fn() } })
    oldPane.detach?.()

    onData?.({ id: 'pty-1', data: 'buffered while detached' })
    expect(receivedByNewPane).not.toHaveBeenCalled()

    const newPane = createIpcPtyTransport({})
    newPane.attach?.({
      existingPtyId: 'pty-1',
      callbacks: { onData: receivedByNewPane }
    })

    expect(receivedByNewPane).toHaveBeenCalledWith('buffered while detached')

    onData?.({ id: 'pty-1', data: 'live after reattach' })
    expect(receivedByNewPane).toHaveBeenCalledWith('live after reattach')
  })

  it('exposes the connection identity captured at transport creation', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')

    expect(createIpcPtyTransport({}).getConnectionId?.()).toBeNull()
    expect(createIpcPtyTransport({ connectionId: 'ssh-1' }).getConnectionId?.()).toBe('ssh-1')
  })

  it('exposes local session metadata only for local IPC PTYs', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const localTransport = createIpcPtyTransport({
      cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo',
      shellOverride: 'wsl.exe',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo',
          distro: 'Ubuntu-24.04',
          reason: 'project-override',
          cacheKey: 'repo:wsl'
        }
      }
    })
    const sshTransport = createIpcPtyTransport({
      connectionId: 'ssh-1',
      cwd: 'C:\\Users\\alice\\repo',
      shellOverride: 'cmd.exe'
    })

    expect(localTransport.getLocalSessionMetadata?.()).toEqual({
      cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo',
      shellOverride: 'wsl.exe'
    })
    expect(sshTransport.getLocalSessionMetadata?.()).toBeNull()
  })

  it('keeps captured Windows and WSL metadata when existing PTYs reattach', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const currentWslForWindowsPty = createIpcPtyTransport({
      cwd: 'C:\\repo',
      shellOverride: 'pwsh.exe',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo',
          distro: 'Ubuntu-24.04',
          reason: 'project-override',
          cacheKey: 'repo:wsl'
        }
      }
    })
    const currentWindowsForWslPty = createIpcPtyTransport({
      cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo',
      shellOverride: 'wsl.exe',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo',
          reason: 'project-override',
          cacheKey: 'repo:windows'
        }
      }
    })

    currentWslForWindowsPty.attach({ existingPtyId: 'windows-pty', callbacks: {} })
    currentWindowsForWslPty.attach({ existingPtyId: 'wsl-pty', callbacks: {} })

    expect(currentWslForWindowsPty.getLocalSessionMetadata?.()).toEqual({
      cwd: 'C:\\repo',
      shellOverride: 'pwsh.exe'
    })
    expect(currentWindowsForWslPty.getLocalSessionMetadata?.()).toEqual({
      cwd: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo',
      shellOverride: 'wsl.exe'
    })
  })

  it('sends the missing-cwd fallback flag only for local IPC spawns', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>

    const transport = createIpcPtyTransport({ cwdFallback: 'worktree' })
    await transport.connect({ url: '', callbacks: {} })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwdFallback: 'worktree' }))
    transport.disconnect()
  })

  it('omits the missing-cwd fallback flag when the IPC transport is SSH-tagged', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>

    const transport = createIpcPtyTransport({ connectionId: 'ssh-1', cwdFallback: 'worktree' })
    await transport.connect({ url: '', callbacks: {} })

    expect(spawn).toHaveBeenCalledWith(expect.not.objectContaining({ cwdFallback: 'worktree' }))
    transport.disconnect()
  })

  it('omits the missing-cwd fallback flag for session reattach spawns', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>

    const transport = createIpcPtyTransport({ cwdFallback: 'worktree' })
    await transport.connect({ url: '', callbacks: {}, sessionId: 'session-1' })

    expect(spawn).toHaveBeenCalledWith(expect.not.objectContaining({ cwdFallback: 'worktree' }))
    transport.disconnect()
  })

  it('mints a fresh id instead of reopening a discarded same-id session', async () => {
    const { discardPreHandlerPtyState, clearPreHandlerPtyState } =
      await import('./pty-pre-handler-buffer')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const discardedId = 'removed-worktree@@discarded-session'
    discardPreHandlerPtyState(discardedId)

    await createIpcPtyTransport({ cwdFallback: 'worktree' }).connect({
      url: '',
      sessionId: discardedId,
      callbacks: {}
    })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwdFallback: 'worktree' }))
    expect(spawn).toHaveBeenCalledWith(expect.not.objectContaining({ sessionId: discardedId }))
    clearPreHandlerPtyState(discardedId)
  })

  it('delivers a buffered dead-session exit without respawning the same session id', async () => {
    const { bufferPreHandlerPtyData, bufferPreHandlerPtyExit } =
      await import('./pty-pre-handler-buffer')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const onDataCallback = vi.fn()
    const onExitCallback = vi.fn()
    const onDisconnect = vi.fn()
    const onPtyExit = vi.fn()
    const sessionId = 'dead-parked-session'
    bufferPreHandlerPtyData(sessionId, 'final output')
    bufferPreHandlerPtyExit(sessionId, 17)

    const transport = createIpcPtyTransport({ onPtyExit })
    const result = await transport.connect({
      url: '',
      sessionId,
      callbacks: { onData: onDataCallback, onExit: onExitCallback, onDisconnect }
    })

    expect(result).toEqual({ id: sessionId, exitedBeforeAttach: true })
    expect(spawn).not.toHaveBeenCalled()
    expect(onDataCallback).toHaveBeenCalledWith('final output')
    expect(onExitCallback).toHaveBeenCalledWith(17)
    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(onPtyExit).toHaveBeenCalledWith(sessionId)
    expect(transport.isConnected()).toBe(false)
  })

  it('returns startup cwd fallback metadata to the connection layer', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    spawn.mockResolvedValueOnce({
      id: 'pty-1',
      startupCwdFallback: { kind: 'worktree', cwd: '/repo/app' }
    })

    const transport = createIpcPtyTransport({ cwdFallback: 'worktree' })

    await expect(transport.connect({ url: '', callbacks: {} })).resolves.toEqual({
      id: 'pty-1',
      startupCwdFallback: { kind: 'worktree', cwd: '/repo/app' }
    })
    transport.disconnect()
  })

  it('defers title side effects until after terminal data is delivered', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const onDataCallback = vi.fn(() => {
      expect(onTitleChange).not.toHaveBeenCalled()
    })
    const transport = createIpcPtyTransport({ onTitleChange })

    await transport.connect({ url: '', callbacks: { onData: onDataCallback } })

    onData?.({ id: 'pty-1', data: '\u001b]0;title-one\u0007body' })

    expect(onDataCallback).toHaveBeenCalledWith('\u001b]0;title-one\u0007body')
    expect(onTitleChange).not.toHaveBeenCalled()

    await flushPtySideEffects()

    expect(onTitleChange).toHaveBeenCalledWith('title-one', 'title-one')
    transport.disconnect()
  })

  it('runs title side effects even when the data callback does not render the chunk', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const onDataCallback = vi.fn()
    const transport = createIpcPtyTransport({ onTitleChange })

    await transport.connect({ url: '', callbacks: { onData: onDataCallback } })

    onData?.({ id: 'pty-1', data: '\u001b]0;hidden-title\u0007' })

    expect(onDataCallback).toHaveBeenCalledWith('\u001b]0;hidden-title\u0007')
    expect(onTitleChange).not.toHaveBeenCalled()

    await flushPtySideEffects()

    expect(onTitleChange).toHaveBeenCalledWith('hidden-title', 'hidden-title')
    transport.disconnect()
  })

  it('drops the OSC-9999 cross-chunk carry on resetAgentStatusCarry', async () => {
    // Why: a model-restore marker means bytes were dropped between chunks —
    // a partial OSC-9999 prefix carried across that gap would swallow the
    // next live chunk's head as bogus status payload.
    const { createPtyOutputProcessor } = await import('./pty-transport')
    const processor = createPtyOutputProcessor({})
    const callbacks = { onData: vi.fn() }

    processor.processData('\x1b]9999;', callbacks)
    expect(callbacks.onData).toHaveBeenLastCalledWith('')

    processor.resetAgentStatusCarry()
    processor.processData('plain output after the gap', callbacks)

    expect(callbacks.onData).toHaveBeenLastCalledWith('plain output after the gap')
  })

  it('does not schedule PTY side-effect drains for ordinary output with no working title', async () => {
    vi.useFakeTimers()
    try {
      const { createPtyOutputProcessor } = await import('./pty-transport')
      const onTitleChange = vi.fn()
      const onBell = vi.fn()
      const processor = createPtyOutputProcessor({ onTitleChange, onBell })
      const callbacks = { onData: vi.fn() }

      processor.processData('plain command output\r\n'.repeat(50), callbacks)

      expect(callbacks.onData).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      expect(onTitleChange).not.toHaveBeenCalled()
      expect(onBell).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('compacts ignored Cursor native titles into one deferred drain', async () => {
    vi.useFakeTimers()
    try {
      const { createPtyOutputProcessor } = await import('./pty-transport')
      const onTitleChange = vi.fn()
      const processor = createPtyOutputProcessor({ onTitleChange })
      const callbacks = { onData: vi.fn() }
      const ignoredTitles = Array.from({ length: 4_096 }, () => '\x1b]0;Cursor Agent\x07').join('')

      processor.processData(ignoredTitles, callbacks)

      expect(vi.getTimerCount()).toBe(1)
      await vi.runOnlyPendingTimersAsync()

      expect(vi.getTimerCount()).toBe(0)
      expect(onTitleChange).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets an ignored Cursor native title clear a pending stale-title fallback', async () => {
    vi.useFakeTimers()
    try {
      const { createPtyOutputProcessor } = await import('./pty-transport')
      const onAgentBecameIdle = vi.fn()
      const processor = createPtyOutputProcessor({
        onTitleChange: vi.fn(),
        onAgentBecameIdle,
        onAgentBecameWorking: vi.fn()
      })
      const callbacks = { onData: vi.fn() }

      processor.processData('\x1b]0;⠋ Cursor Agent\x07', callbacks)
      await vi.advanceTimersByTimeAsync(0)
      processor.processData('plain output\r\n', callbacks)
      await vi.advanceTimersByTimeAsync(0)

      processor.processData('\x1b]0;Cursor Agent\x07', callbacks)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(3_000)

      expect(onAgentBecameIdle).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-arms stale-title fallback after a later title-free output scan', async () => {
    vi.useFakeTimers()
    try {
      const { createPtyOutputProcessor } = await import('./pty-transport')
      const onTitleChange = vi.fn()
      const processor = createPtyOutputProcessor({
        onTitleChange,
        onAgentBecameIdle: vi.fn(),
        onAgentBecameWorking: vi.fn()
      })
      const callbacks = { onData: vi.fn() }

      processor.processData('\x1b]0;⠋ Cursor Agent\x07', callbacks)
      await vi.advanceTimersByTimeAsync(0)
      onTitleChange.mockClear()
      processor.processData('\x1b]0;Cursor Agent\x07', callbacks)
      processor.processData('plain output\r\n', callbacks)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(3_000)

      expect(onTitleChange).toHaveBeenCalledWith('Cursor Agent', 'Cursor Agent')
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves stale-title detection after compacting deferred side effects', async () => {
    vi.useFakeTimers()
    try {
      const { createPtyOutputProcessor } = await import('./pty-transport')
      const onTitleChange = vi.fn()
      const onAgentBecameWorking = vi.fn()
      const onAgentBecameIdle = vi.fn()
      const processor = createPtyOutputProcessor({
        onTitleChange,
        onAgentBecameWorking,
        onAgentBecameIdle
      })
      const callbacks = { onData: vi.fn() }

      processor.processData('\x1b]0;. Claude working\x07', callbacks)
      for (let i = 0; i < 20; i++) {
        processor.processData(`plain output ${i}\r\n`, callbacks)
      }

      expect(onAgentBecameWorking).not.toHaveBeenCalled()
      vi.advanceTimersByTime(0)

      expect(onAgentBecameWorking).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(3_000)

      expect(onAgentBecameIdle).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('limits deferred PTY side-effect work per timer tick', async () => {
    vi.useFakeTimers()
    try {
      const { createPtyOutputProcessor } = await import('./pty-transport')
      const onTitleChange = vi.fn()
      const processor = createPtyOutputProcessor({ onTitleChange })
      const callbacks = { onData: vi.fn() }

      for (let i = 0; i < 200; i++) {
        processor.processData(`\x1b]0;title-${i}\x07`, callbacks)
      }

      expect(onTitleChange).not.toHaveBeenCalled()
      await vi.runOnlyPendingTimersAsync()

      expect(onTitleChange.mock.calls.length).toBeGreaterThan(0)
      expect(onTitleChange.mock.calls.length).toBeLessThan(200)

      await vi.runAllTimersAsync()
      expect(onTitleChange).toHaveBeenCalledTimes(200)
      expect(onTitleChange).toHaveBeenLastCalledWith('title-199', 'title-199')
    } finally {
      vi.useRealTimers()
    }
  })

  it('limits coalesced OSC titles in one PTY chunk per timer tick', async () => {
    vi.useFakeTimers()
    try {
      const { createPtyOutputProcessor } = await import('./pty-transport')
      const onTitleChange = vi.fn()
      const processor = createPtyOutputProcessor({ onTitleChange })
      const callbacks = { onData: vi.fn() }
      const titles = Array.from({ length: 200 }, (_, i) => `\x1b]0;chunk-title-${i}\x07`).join('')

      processor.processData(titles, callbacks)
      await vi.runOnlyPendingTimersAsync()

      expect(onTitleChange.mock.calls.length).toBeGreaterThan(0)
      expect(onTitleChange.mock.calls.length).toBeLessThan(200)

      await vi.runAllTimersAsync()
      expect(onTitleChange).toHaveBeenCalledTimes(200)
      expect(onTitleChange).toHaveBeenLastCalledWith('chunk-title-199', 'chunk-title-199')
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes all remaining PTY side effects after a partial bounded drain', async () => {
    vi.useFakeTimers()
    try {
      const { createPtyOutputProcessor } = await import('./pty-transport')
      const onTitleChange = vi.fn()
      const processor = createPtyOutputProcessor({ onTitleChange })
      const callbacks = { onData: vi.fn() }

      for (let i = 0; i < 200; i++) {
        processor.processData(`\x1b]0;flush-title-${i}\x07`, callbacks)
      }

      await vi.runOnlyPendingTimersAsync()
      expect(onTitleChange.mock.calls.length).toBeLessThan(200)

      processor.flushPendingSideEffects()

      expect(onTitleChange).toHaveBeenCalledTimes(200)
      expect(onTitleChange).toHaveBeenLastCalledWith('flush-title-199', 'flush-title-199')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still runs stale-title detection when an OSC status chunk has no title', async () => {
    vi.useFakeTimers()
    try {
      const { createPtyOutputProcessor } = await import('./pty-transport')
      const onTitleChange = vi.fn()
      const onAgentStatus = vi.fn()
      const onAgentBecameIdle = vi.fn()
      const processor = createPtyOutputProcessor({
        onTitleChange,
        onAgentStatus,
        onAgentBecameIdle
      })
      const callbacks = { onData: vi.fn() }

      processor.processData('\x1b]0;. Claude working\x07', callbacks)
      processor.processData(
        '\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07plain output\r\n',
        callbacks
      )

      await vi.runOnlyPendingTimersAsync()
      expect(onAgentStatus).toHaveBeenCalledWith({
        state: 'working',
        prompt: 'ship it',
        agentType: 'codex'
      })

      vi.advanceTimersByTime(3_000)
      expect(onAgentBecameIdle).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses acknowledged writes only for local IPC PTYs', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const localTransport = createIpcPtyTransport({})

    await localTransport.connect({ url: '', callbacks: {} })
    await expect(localTransport.sendInputAccepted?.('\x03')).resolves.toBe(true)
    expect(window.api.pty.writeAccepted).toHaveBeenCalledWith('pty-1', '\x03')

    const sshTransport = createIpcPtyTransport({ connectionId: 'ssh-1' })
    await sshTransport.connect({ url: '', callbacks: {} })
    expect(sshTransport.sendInputAccepted).toBeUndefined()
  })

  it('chunks large local IPC terminal input before renderer-to-main writes', async () => {
    vi.useFakeTimers()
    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({})
      const chunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)

      await transport.connect({ url: '', callbacks: {} })

      expect(transport.sendInput(`${chunk}tail`)).toBe(true)
      expect(window.api.pty.write).toHaveBeenCalledTimes(1)
      expect(window.api.pty.write).toHaveBeenNthCalledWith(1, 'pty-1', chunk)

      await vi.runOnlyPendingTimersAsync()

      expect(window.api.pty.write).toHaveBeenCalledTimes(2)
      expect(window.api.pty.write).toHaveBeenNthCalledWith(2, 'pty-1', 'tail')
    } finally {
      vi.useRealTimers()
    }
  })

  it('yields while validating accepted large local IPC terminal input before renderer-to-main writes', async () => {
    vi.useFakeTimers()
    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({})
      const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

      await transport.connect({ url: '', callbacks: {} })

      expect(transport.sendInput(text)).toBe(true)
      expect(window.api.pty.write).not.toHaveBeenCalled()

      await vi.runAllTimersAsync()

      expect(
        vi
          .mocked(window.api.pty.write)
          .mock.calls.map(([, chunk]) => chunk)
          .join('')
      ).toBe(text)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects oversized local IPC terminal input before renderer-to-main writes', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})

    await transport.connect({ url: '', callbacks: {} })

    expect(transport.sendInput('x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1))).toBe(false)
    expect(window.api.pty.write).not.toHaveBeenCalled()
  })

  it('chunks large acknowledged local IPC terminal input before writeAccepted IPC', async () => {
    vi.useFakeTimers()
    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({})
      const chunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)

      await transport.connect({ url: '', callbacks: {} })

      const accepted = transport.sendInputAccepted?.(`${chunk}tail`)
      await Promise.resolve()
      expect(window.api.pty.writeAccepted).toHaveBeenCalledTimes(1)
      expect(window.api.pty.writeAccepted).toHaveBeenNthCalledWith(1, 'pty-1', chunk)

      await vi.runOnlyPendingTimersAsync()

      await expect(accepted).resolves.toBe(true)
      expect(window.api.pty.writeAccepted).toHaveBeenCalledTimes(2)
      expect(window.api.pty.writeAccepted).toHaveBeenNthCalledWith(2, 'pty-1', 'tail')
    } finally {
      vi.useRealTimers()
    }
  })

  it('yields while validating accepted large acknowledged local IPC terminal input before writeAccepted IPC', async () => {
    vi.useFakeTimers()
    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({})
      const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

      await transport.connect({ url: '', callbacks: {} })

      const accepted = transport.sendInputAccepted?.(text)
      await Promise.resolve()
      expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()

      await vi.runAllTimersAsync()

      await expect(accepted).resolves.toBe(true)
      expect(
        vi
          .mocked(window.api.pty.writeAccepted)
          .mock.calls.map(([, chunk]) => chunk)
          .join('')
      ).toBe(text)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects oversized acknowledged local IPC terminal input before writeAccepted IPC', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})

    await transport.connect({ url: '', callbacks: {} })

    await expect(
      transport.sendInputAccepted?.('x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1))
    ).resolves.toBe(false)
    expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
  })

  it('suppresses attention side effects when replaying eager-buffered data during attach', async () => {
    // Why: eager PTY buffers capture output produced before the pane mounted —
    // typically catch-up bytes from a previous app session. A BEL or
    // completion-style title arriving in that replay must NOT produce a fresh
    // alert. onTitleChange still fires so the tab label restores correctly,
    // but onBell and onAgentBecameIdle are gated by suppressAttentionEvents.
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentBecameIdle = vi.fn()

    const handle = registerEagerPtyBuffer('pty-restored', vi.fn())
    onData?.({
      id: 'pty-restored',
      data: ']0;. Claude working]0;* Claude done'
    })

    const transport = createIpcPtyTransport({
      onTitleChange,
      onBell,
      onAgentBecameIdle
    })

    transport.attach({
      existingPtyId: 'pty-restored',
      callbacks: {}
    })

    expect(handle.flush()).toBe('')
    await flushPtySideEffects()
    expect(onTitleChange).toHaveBeenCalledWith('* Claude done', '* Claude done')
    expect(onBell).not.toHaveBeenCalled()
    expect(onAgentBecameIdle).not.toHaveBeenCalled()
  })

  it('resets replay parser state after deferred side effects drain', async () => {
    // Why: replay side effects run after xterm receives data. Attach cleanup
    // still has to wait for them, or a replayed partial OSC can make the first
    // live BEL look like an OSC terminator instead of an attention bell.
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')
    const onBell = vi.fn()

    registerEagerPtyBuffer('pty-restored', vi.fn())
    onData?.({
      id: 'pty-restored',
      data: '\x1b]0;partial-title'
    })

    const transport = createIpcPtyTransport({ onBell })
    transport.attach({
      existingPtyId: 'pty-restored',
      callbacks: {}
    })

    await flushPtySideEffects()
    onData?.({ id: 'pty-restored', data: '\x07' })
    await flushPtySideEffects()

    expect(onBell).toHaveBeenCalledTimes(1)
  })

  it('keeps exit sidecars after eager-buffered PTYs attach to a terminal', async () => {
    const { createIpcPtyTransport, registerEagerPtyBuffer, subscribeToPtyExit } =
      await import('./pty-transport')
    const eagerExit = vi.fn()
    const sidecarExit = vi.fn()

    registerEagerPtyBuffer('pty-restored', eagerExit)
    subscribeToPtyExit('pty-restored', sidecarExit)

    createIpcPtyTransport().attach({
      existingPtyId: 'pty-restored',
      callbacks: {}
    })
    onExit?.({ id: 'pty-restored', code: 0 })

    expect(eagerExit).not.toHaveBeenCalled()
    expect(sidecarExit).toHaveBeenCalledWith(0, { hadPrimary: true })
  })

  it('fires onBell for bare BELs but ignores BELs inside OSC sequences', async () => {
    // Why: Claude's OSC titles end with a BEL terminator (`\e]0;…\a`). The
    // stateful bell detector must know it is inside an OSC when that BEL
    // arrives and ignore it — otherwise every agent title change would
    // produce a spurious bell. A bare BEL outside an OSC is what actually
    // raises attention.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onBell = vi.fn()

    const transport = createIpcPtyTransport({ onBell })
    await transport.connect({ url: '', callbacks: {} })

    // OSC-terminating BELs: three titles, zero attention bells.
    onData?.({ id: 'pty-1', data: ']0;title-one' })
    onData?.({ id: 'pty-1', data: ']0;title-two' })
    onData?.({ id: 'pty-1', data: ']0;title-three' })
    await flushPtySideEffects()
    expect(onBell).not.toHaveBeenCalled()

    // Bare BEL outside any OSC: fires once.
    onData?.({ id: 'pty-1', data: '' })
    await flushPtySideEffects()
    expect(onBell).toHaveBeenCalledTimes(1)
  })

  it('bounds the eager buffer to its cap and keeps the most recent output', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-transport')
    const cap = 512 * 1024
    const handle = registerEagerPtyBuffer('pty-restored', vi.fn())

    // 8 x 100 KB = 800 KB of distinct chunks, exceeding the 512 KB cap; the
    // earliest chunks must be dropped while the prompt-bearing tail is kept.
    for (let i = 0; i < 8; i += 1) {
      onData?.({ id: 'pty-restored', data: String.fromCharCode(65 + i).repeat(100 * 1024) })
    }
    onData?.({ id: 'pty-restored', data: 'PROMPT$' })

    const flushed = handle.flush()
    expect(flushed.length).toBeLessThanOrEqual(cap)
    expect(flushed.endsWith('PROMPT$')).toBe(true)
    expect(flushed).not.toContain('A') // oldest chunk trimmed
  })

  it('caps a single oversized eager chunk to its most-recent tail', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-transport')
    const cap = 512 * 1024
    const handle = registerEagerPtyBuffer('pty-restored', vi.fn())

    // One chunk larger than the cap must not be stored whole.
    onData?.({ id: 'pty-restored', data: `${'x'.repeat(cap)}TAIL$` })

    const flushed = handle.flush()
    expect(flushed.length).toBeLessThanOrEqual(cap)
    expect(flushed.endsWith('TAIL$')).toBe(true)
  })

  it('drains pre-handler data and exit into eager buffers for fast background PTYs', async () => {
    const { ensurePtyDispatcher, registerEagerPtyBuffer } = await import('./pty-transport')
    const onEagerExit = vi.fn()

    ensurePtyDispatcher()
    onData?.({ id: 'pty-fast-setup', data: 'setup failed fast\n' })
    onExit?.({ id: 'pty-fast-setup', code: 1 })

    const handle = registerEagerPtyBuffer('pty-fast-setup', onEagerExit)

    expect(handle.flush()).toBe('setup failed fast\n')
    await Promise.resolve()
    expect(onEagerExit).toHaveBeenCalledWith('pty-fast-setup', 1)
  })

  it('enforces the eager buffer cap in UTF-8 bytes for multi-byte output', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-transport')
    const cap = 512 * 1024
    const handle = registerEagerPtyBuffer('pty-restored', vi.fn())
    const output = `${'界'.repeat(cap)}PROMPT$`
    const encodeSpy = vi.spyOn(TextEncoder.prototype, 'encode')

    onData?.({ id: 'pty-restored', data: output })

    const flushed = handle.flush()
    expect(new TextEncoder().encode(flushed).byteLength).toBeLessThanOrEqual(cap)
    expect(flushed.endsWith('PROMPT$')).toBe(true)
    expect(encodeSpy).not.toHaveBeenCalledWith(output)
    encodeSpy.mockRestore()
  })

  it('preserves a BOM when it starts the retained oversized eager-buffer tail', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-transport')
    const cap = 512 * 1024
    const handle = registerEagerPtyBuffer('pty-restored', vi.fn())

    onData?.({ id: 'pty-restored', data: `${'x'.repeat(16)}\uFEFF${'y'.repeat(cap - 3)}` })

    const flushed = handle.flush()
    expect(new TextEncoder().encode(flushed).byteLength).toBe(cap)
    expect(flushed.startsWith('\uFEFF')).toBe(true)
  })

  it('does not use Array.shift while trimming many eager chunks', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-transport')
    const handle = registerEagerPtyBuffer('pty-restored', vi.fn())
    const originalShift = Array.prototype.shift

    try {
      // Why: this hot path used to call Array.shift() once per trim, which
      // reindexed the live buffer and made many small chunks quadratic.
      Object.defineProperty(Array.prototype, 'shift', {
        configurable: true,
        writable: true,
        value() {
          throw new Error('Array.shift should not be used by the eager buffer')
        }
      })
      for (let i = 0; i < 2048; i += 1) {
        onData?.({ id: 'pty-restored', data: 'x'.repeat(1024) })
      }
    } finally {
      Object.defineProperty(Array.prototype, 'shift', {
        configurable: true,
        writable: true,
        value: originalShift
      })
    }

    expect(handle.flush().length).toBeLessThanOrEqual(512 * 1024)
  })

  it('routes eager-buffered bytes through onReplayData so the renderer can engage the replay guard', async () => {
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')

    // Why: eager-buffered bytes often contain query sequences (e.g. DA1 `\x1b[c`)
    // left over from a previous session. Routing them through onData instead of
    // onReplayData would bypass pty-connection's replay guard and xterm would
    // auto-reply to those queries, leaking stray input into the shell.
    const bufferedPayload = 'hello\x1b[cworld'

    const handle = registerEagerPtyBuffer('pty-restored', vi.fn())
    onData?.({
      id: 'pty-restored',
      data: bufferedPayload
    })

    const transport = createIpcPtyTransport()
    const onDataCallback = vi.fn()
    const onReplayData = vi.fn()

    transport.attach({
      existingPtyId: 'pty-restored',
      callbacks: {
        onData: onDataCallback,
        onReplayData
      }
    })

    expect(handle.flush()).toBe('')
    expect(onReplayData).toHaveBeenCalledWith(bufferedPayload)
    expect(onDataCallback).not.toHaveBeenCalledWith(bufferedPayload)
  })

  it('replays display-bearing eager-buffered output with default clear semantics', async () => {
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')

    const bufferedPayload = '\x1b[?1049hAutomation agent is running'
    registerEagerPtyBuffer('pty-automation', vi.fn())
    onData?.({
      id: 'pty-automation',
      data: bufferedPayload
    })

    const transport = createIpcPtyTransport()
    const onReplayData = vi.fn()

    transport.attach({
      existingPtyId: 'pty-automation',
      callbacks: {
        onReplayData
      }
    })

    expect(onReplayData.mock.calls).toEqual([[bufferedPayload]])
  })

  it('does not clear before replaying title-only eager-buffered output', async () => {
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')

    const bufferedPayload = '\x1b]0;Restored title\x07'
    registerEagerPtyBuffer('pty-title-only', vi.fn())
    onData?.({
      id: 'pty-title-only',
      data: bufferedPayload
    })

    const onTitleChange = vi.fn()
    const transport = createIpcPtyTransport({ onTitleChange })
    const onReplayData = vi.fn()

    transport.attach({
      existingPtyId: 'pty-title-only',
      callbacks: {
        onReplayData
      }
    })

    // Why: title/control frames restore metadata but do not redraw a terminal
    // frame; clearing before them would erase the persisted scrollback.
    const clear = '\x1b[2J\x1b[3J\x1b[H'
    expect(onReplayData.mock.calls).toEqual([[bufferedPayload, { clearBeforeReplay: false }]])
    expect(onReplayData).not.toHaveBeenCalledWith(clear)
    expect(onTitleChange).toHaveBeenCalledWith('Restored title', 'Restored title')
  })

  it('does not write an unterminated title-only eager buffer into replay', async () => {
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')

    const bufferedPayload = '\x1b]0;partial restored title'
    registerEagerPtyBuffer('pty-partial-title', vi.fn())
    onData?.({
      id: 'pty-partial-title',
      data: bufferedPayload
    })

    const transport = createIpcPtyTransport()
    const onReplayData = vi.fn()

    transport.attach({
      existingPtyId: 'pty-partial-title',
      callbacks: {
        onReplayData
      }
    })

    const clear = '\x1b[2J\x1b[3J\x1b[H'
    expect(onReplayData.mock.calls).toEqual([['', { clearBeforeReplay: false }]])
    expect(onReplayData).not.toHaveBeenCalledWith(clear)
  })

  it('does not let an unterminated OSC 9999 eager buffer swallow live output', async () => {
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')

    registerEagerPtyBuffer('pty-partial-status', vi.fn())
    onData?.({
      id: 'pty-partial-status',
      data: '\x1b]9999;{"state":"working"'
    })

    const transport = createIpcPtyTransport({ onAgentStatus: vi.fn() })
    const onReplayData = vi.fn()
    const onDataCallback = vi.fn()

    transport.attach({
      existingPtyId: 'pty-partial-status',
      callbacks: {
        onData: onDataCallback,
        onReplayData
      }
    })

    expect(onReplayData.mock.calls).toEqual([['', { clearBeforeReplay: false }]])

    onData?.({
      id: 'pty-partial-status',
      data: 'live output'
    })

    expect(onDataCallback).toHaveBeenCalledWith('live output')
  })

  it('does not clear before replaying OSC 9999-only eager-buffered output', async () => {
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')

    registerEagerPtyBuffer('pty-status-only', vi.fn())
    onData?.({
      id: 'pty-status-only',
      data: '\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07'
    })

    const transport = createIpcPtyTransport()
    const onReplayData = vi.fn()

    transport.attach({
      existingPtyId: 'pty-status-only',
      callbacks: {
        onReplayData
      }
    })

    // Why: OSC 9999 is stripped before xterm receives replay data. A non-empty
    // raw status frame must not clear restored scrollback and replay nothing.
    const clear = '\x1b[2J\x1b[3J\x1b[H'
    expect(onReplayData.mock.calls).toEqual([['', { clearBeforeReplay: false }]])
    expect(onReplayData).not.toHaveBeenCalledWith(clear)
  })

  it('does not clear on attach when there is no eager-buffered output', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')

    const transport = createIpcPtyTransport()
    const onDataCallback = vi.fn()
    const onReplayData = vi.fn()

    transport.attach({
      existingPtyId: 'pty-attached',
      callbacks: {
        onData: onDataCallback,
        onReplayData
      }
    })

    // Why: restored scrollback may already be in xterm before attach. An
    // empty eager buffer must not erase it and leave the pane cursor-only.
    expect(onReplayData).not.toHaveBeenCalled()
    expect(onDataCallback).not.toHaveBeenCalled()
  })

  it('does not clear on attach when the eager buffer is empty', async () => {
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')

    registerEagerPtyBuffer('pty-attached', vi.fn())
    const transport = createIpcPtyTransport()
    const onDataCallback = vi.fn()
    const onReplayData = vi.fn()

    transport.attach({
      existingPtyId: 'pty-attached',
      callbacks: {
        onData: onDataCallback,
        onReplayData
      }
    })

    // Why: a live PTY can have an eager handle before any bytes arrive. Clearing
    // here would destroy the scrollback restored by TerminalPane mount.
    expect(onReplayData).not.toHaveBeenCalled()
    expect(onDataCallback).not.toHaveBeenCalled()
  })

  it('skips the attach-time clear sequence for alternate-screen sessions', async () => {
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')

    const bufferedPayload = '\x1b[?1049hAlternate screen is already restored'
    registerEagerPtyBuffer('pty-alt-screen', vi.fn())
    onData?.({
      id: 'pty-alt-screen',
      data: bufferedPayload
    })

    const transport = createIpcPtyTransport()
    const onDataCallback = vi.fn()
    const onReplayData = vi.fn()

    transport.attach({
      existingPtyId: 'pty-alt-screen',
      isAlternateScreen: true,
      callbacks: {
        onData: onDataCallback,
        onReplayData
      }
    })

    // Why: alternate-screen snapshots already fill the viewport; emitting the
    // clear would erase the restored content. Neither path should see it.
    const clear = '\x1b[2J\x1b[3J\x1b[H'
    expect(onReplayData.mock.calls).toEqual([[bufferedPayload, { clearBeforeReplay: false }]])
    expect(onReplayData).not.toHaveBeenCalledWith(clear)
    expect(onDataCallback).not.toHaveBeenCalledWith(clear)
  })

  it('passes startup commands through PTY spawn instead of writing them after connect', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockResolvedValue({ id: 'pty-1' })
    const writeMock = vi.fn()

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: writeMock,
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
            onExit = callback
            return () => {}
          })
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport({
      cwd: '/tmp/worktree',
      env: { FOO: 'bar' },
      command: 'echo hello'
    })

    await transport.connect({
      url: '',
      cols: 120,
      rows: 40,
      callbacks: {}
    })

    expect(spawnMock).toHaveBeenCalledWith({
      cols: 120,
      rows: 40,
      cwd: '/tmp/worktree',
      env: { FOO: 'bar' },
      command: 'echo hello'
    })
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('preserves snapshot dimensions when reattaching', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockResolvedValue({
      id: 'pty-reattach',
      isReattach: true,
      launchAgent: 'droid',
      snapshot: 'snapshot data',
      snapshotCols: 132,
      snapshotRows: 43
    })

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
            onExit = callback
            return () => {}
          })
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport()
    const result = await transport.connect({
      url: '',
      sessionId: 'pty-reattach',
      callbacks: {}
    })

    expect(result).toEqual({
      id: 'pty-reattach',
      launchAgent: 'droid',
      snapshot: 'snapshot data',
      snapshotCols: 132,
      snapshotRows: 43,
      isAlternateScreen: undefined,
      coldRestore: undefined,
      replay: undefined,
      sessionExpired: undefined
    })
  })

  it('drops an unknown daemon launch identity from the connection result', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    spawn.mockResolvedValueOnce({
      id: 'pty-unknown-launch-agent',
      isReattach: true,
      launchAgent: 'not-an-agent'
    })

    const result = await createIpcPtyTransport({}).connect({ url: '', callbacks: {} })

    expect(result).toEqual({
      id: 'pty-unknown-launch-agent',
      snapshot: undefined,
      snapshotCols: undefined,
      snapshotRows: undefined,
      isAlternateScreen: undefined,
      sessionExpired: undefined,
      coldRestore: undefined,
      replay: undefined,
      pendingEscapeTailAnsi: undefined
    })
  })

  it('threads the daemon pendingEscapeTailAnsi through the reattach connect result (#7329)', async () => {
    // Why: the local daemon ships the mid-escape tail on the spawn/reattach
    // result; dropping it here silently regressed the local half of #7329
    // (the consumer test injects at the transport boundary, so only this
    // asserts the IPC threading).
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockResolvedValue({
      id: 'pty-reattach-tail',
      isReattach: true,
      snapshot: 'snapshot data',
      snapshotCols: 80,
      snapshotRows: 24,
      pendingEscapeTailAnsi: '\x1b[3'
    })

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport()
    const result = await transport.connect({
      url: '',
      sessionId: 'pty-reattach-tail',
      callbacks: {}
    })

    expect(result).toMatchObject({
      id: 'pty-reattach-tail',
      pendingEscapeTailAnsi: '\x1b[3'
    })
  })

  it('does not kill a pre-existing session when a reattach resolves after destroy', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnControls: { resolve: ((value: { id: string }) => void) | null } = { resolve: null }
    const spawnPromise = new Promise<{ id: string }>((resolve) => {
      spawnControls.resolve = resolve
    })
    const spawnMock = vi.fn().mockReturnValue(spawnPromise)
    const killMock = vi.fn()

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: killMock,
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport({})
    const connectPromise = transport.connect({
      url: '',
      callbacks: {},
      // A reattach targets a session that existed before this transport;
      // destroying the view must not reap the user's live shell.
      sessionId: 'pty-preexisting'
    })

    transport.destroy?.()
    if (!spawnControls.resolve) {
      throw new Error('Expected spawn resolver to be captured')
    }
    spawnControls.resolve({ id: 'pty-preexisting' })
    await connectPromise

    expect(killMock).not.toHaveBeenCalledWith('pty-preexisting')
  })

  it('kills a PTY that finishes spawning after the transport was destroyed', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnControls: { resolve: ((value: { id: string }) => void) | null } = { resolve: null }
    const spawnPromise = new Promise<{ id: string }>((resolve) => {
      spawnControls.resolve = resolve
    })
    const spawnMock = vi.fn().mockReturnValue(spawnPromise)
    const killMock = vi.fn()
    const onPtySpawn = vi.fn()

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: killMock,
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
            onExit = callback
            return () => {}
          })
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport({ onPtySpawn })
    const connectPromise = transport.connect({
      url: '',
      callbacks: {}
    })

    transport.destroy?.()
    if (!spawnControls.resolve) {
      throw new Error('Expected spawn resolver to be captured')
    }
    spawnControls.resolve({ id: 'pty-late' })
    await connectPromise

    expect(killMock).toHaveBeenCalledWith('pty-late')
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBeNull()
  })

  it('unregisterPtyDataHandlers prevents final data burst from triggering notifications', async () => {
    const { createIpcPtyTransport, unregisterPtyDataHandlers } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentBecameIdle = vi.fn()
    const onAgentBecameWorking = vi.fn()
    const onPtyExit = vi.fn()

    const transport = createIpcPtyTransport({
      onTitleChange,
      onBell,
      onAgentBecameIdle,
      onAgentBecameWorking,
      onPtyExit
    })

    await transport.connect({ url: '', callbacks: {} })

    // Agent starts working
    onData?.({ id: 'pty-1', data: ']0;. Claude working' })
    await flushPtySideEffects()
    expect(onAgentBecameWorking).toHaveBeenCalledTimes(1)

    // Simulate shutdownWorktreeTerminals: unregister data handlers before kill.
    unregisterPtyDataHandlers(['pty-1'])

    // Final data burst from main process (flushed before exit) — contains a
    // title change and a BEL. Neither should produce a notification because
    // the data handler was removed.
    onData?.({ id: 'pty-1', data: ']0;Claude done' })
    expect(onAgentBecameIdle).not.toHaveBeenCalled()
    expect(onBell).not.toHaveBeenCalled()

    // Exit handler should still work (exit handlers are kept alive)
    onExit?.({ id: 'pty-1', code: -1 })
    expect(onPtyExit).toHaveBeenCalledWith('pty-1')
  })

  it('restores data handlers when an intentional shutdown fails before exit', async () => {
    const {
      createIpcPtyTransport,
      restorePtyDataHandlersAfterFailedShutdown,
      unregisterPtyDataHandlers
    } = await import('./pty-transport')
    const onDataCallback = vi.fn()
    const transport = createIpcPtyTransport()

    await transport.connect({ url: '', callbacks: { onData: onDataCallback } })

    const snapshots = unregisterPtyDataHandlers(['pty-1'])
    onData?.({ id: 'pty-1', data: 'final burst while detached' })
    expect(onDataCallback).not.toHaveBeenCalled()

    restorePtyDataHandlersAfterFailedShutdown(snapshots)
    onData?.({ id: 'pty-1', data: 'live again' })

    expect(onDataCallback).toHaveBeenCalledWith('live again')
  })

  it('unregisterPtyDataHandlers cancels staleTitleTimer so it cannot fire stale idle transition', async () => {
    vi.useFakeTimers()
    try {
      const { createIpcPtyTransport, unregisterPtyDataHandlers } = await import('./pty-transport')
      const onTitleChange = vi.fn()
      const onAgentBecameIdle = vi.fn()
      const onAgentBecameWorking = vi.fn()

      const transport = createIpcPtyTransport({
        onTitleChange,
        onAgentBecameIdle,
        onAgentBecameWorking
      })

      await transport.connect({ url: '', callbacks: {} })

      // Agent starts working — sets the title to a working indicator
      onData?.({ id: 'pty-1', data: ']0;. Claude working' })
      vi.advanceTimersByTime(0)
      expect(onAgentBecameWorking).toHaveBeenCalledTimes(1)

      // Data arrives without a title change — starts the 3 s staleTitleTimer
      onData?.({ id: 'pty-1', data: 'some output without title\r\n' })
      vi.advanceTimersByTime(0)

      // Simulate shutdownWorktreeTerminals: unregister handlers which should
      // cancel the pending staleTitleTimer AND reset the agent tracker so the
      // accumulated working state cannot produce a stale idle transition.
      unregisterPtyDataHandlers(['pty-1'])

      // Advance past the 3 s stale-title timeout
      vi.advanceTimersByTime(4000)

      // The staleTitleTimer must NOT have fired onAgentBecameIdle
      expect(onAgentBecameIdle).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses the error toast when pty:spawn rejects with TerminalKilledError', async () => {
    // Why: after the user hits "Kill All" in Settings → Manage Sessions, a
    // remounted pane's connect() will call pty:spawn with a killed session
    // ID. The main-side tombstone rejects with TerminalKilledError. That
    // rejection is the kill working as intended — not a bug — so the
    // transport must not surface a "please file an issue" toast. Match the
    // IPC-wrapped form Electron actually throws ("Error invoking remote
    // method 'pty:spawn': TerminalKilledError: Session \"...\" was
    // explicitly killed") to exercise the real error path.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `Error invoking remote method 'pty:spawn': TerminalKilledError: Session "pty-dead" was explicitly killed`
        )
      )

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport()
    const onError = vi.fn()

    const result = await transport.connect({
      url: '',
      sessionId: 'pty-dead',
      callbacks: { onError }
    })

    expect(onError).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })

  it('still surfaces non-kill spawn errors via onError', async () => {
    // Why: the TerminalKilledError suppression must be narrowly scoped —
    // unrelated spawn failures (no shell binary, bad cwd, etc.) still need
    // to reach the user so they can act on them. Guard against an
    // over-broad `.includes` match regressing and swallowing real errors.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockRejectedValue(new Error('ENOENT: spawn /bin/nope not found'))

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport()
    const onError = vi.fn()

    await transport.connect({
      url: '',
      callbacks: { onError }
    })

    expect(onError).toHaveBeenCalledWith('ENOENT: spawn /bin/nope not found')
  })

  it('surfaces the SSH-not-active toast for a regular SSH target with no PTY provider', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockRejectedValue(new Error('No PTY provider for connection ssh-1'))
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const onError = vi.fn()
    await createIpcPtyTransport({ connectionId: 'ssh-1' }).connect({
      url: '',
      callbacks: { onError }
    })

    expect(onError).toHaveBeenCalledWith(
      'SSH connection is not active. Use the reconnect dialog or Settings to connect.'
    )
  })

  it('suppresses the SSH-not-active toast for a runtime-owned (per-workspace-env) target', async () => {
    // Why: a runtime-owned SSH target disappearing is expected teardown (e.g. the workspace was
    // deleted) — there's no reconnect dialog for it, so no toast should fire.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi
      .fn()
      .mockRejectedValue(new Error('No PTY provider for connection runtime-ssh-orca-1'))
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const onError = vi.fn()
    await createIpcPtyTransport({ connectionId: 'runtime-ssh-orca-1' }).connect({
      url: '',
      callbacks: { onError }
    })

    expect(onError).not.toHaveBeenCalled()
  })

  it('recovers a stale cross-connection SSH reattach as expired instead of a red error toast', async () => {
    // Why: a restored SSH pty id embeds the connection it was created under. If
    // the pane reattaches under a different connection the main-side router
    // rejects with "belongs to SSH connection" — that session is unreachable, so
    // we drop it (sessionExpired) and spawn fresh rather than surfacing a crash.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'PTY ssh:ssh-1779863656395-57g1q1@@pty-3 belongs to SSH connection "ssh-1779863656395-57g1q1"'
        )
      )
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const onError = vi.fn()
    const result = await createIpcPtyTransport({ connectionId: 'ssh-other' }).connect({
      url: '',
      sessionId: 'ssh:ssh-1779863656395-57g1q1@@pty-3',
      callbacks: { onError }
    })

    expect(onError).not.toHaveBeenCalled()
    expect(result).toEqual({
      id: 'ssh:ssh-1779863656395-57g1q1@@pty-3',
      sessionExpired: true
    })
  })

  it('surfaces terminal session state save failures without the Electron IPC wrapper', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const wrappedMessage = `Error invoking remote method 'pty:spawn': Error: ${createTerminalSessionStateSaveFailureMessage()}`
    const spawnMock = vi.fn().mockRejectedValue(new Error(wrappedMessage))

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport()
    const onError = vi.fn()

    await transport.connect({
      url: '',
      callbacks: { onError }
    })

    expect(onError).toHaveBeenCalledWith(createTerminalSessionStateSaveFailureMessage())
  })

  it('keeps the exit observer alive after detach so remounts do not reuse dead PTYs', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onPtyExit = vi.fn()
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({
      onPtyExit,
      onTitleChange
    })

    transport.attach({
      existingPtyId: 'pty-detached',
      callbacks: {
        onData: vi.fn(),
        onDisconnect: vi.fn()
      }
    })

    transport.detach?.()

    onData?.({ id: 'pty-detached', data: ']0;Detached title' })
    expect(onTitleChange).not.toHaveBeenCalled()

    onExit?.({ id: 'pty-detached', code: 0 })

    expect(onPtyExit).toHaveBeenCalledWith('pty-detached')
    expect(transport.getPtyId()).toBeNull()
  })
})

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
    runtimeCall.mockResolvedValue({
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
    })
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
