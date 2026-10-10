import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushPtySideEffects,
  installIpcPtyWindow,
  restorePtySpecWindow
} from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null
  let onExit:
    | ((payload: { id: string; code: number; preserveRendererBinding?: boolean }) => void)
    | null = null

  beforeEach(() => {
    vi.resetModules()
    onData = null
    onExit = null
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        onData = callback
      },
      exit: (callback) => {
        onExit = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it('suppresses attention side effects when replaying eager-buffered data during attach', async () => {
    // Why: replayed eager output must not raise fresh alerts — bell/idle suppressed, title still restores.
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
    // Why: cleanup must await deferred replay side effects, else a partial OSC makes the first live BEL look like an OSC terminator.
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

  it('bounds the eager buffer to its cap and keeps the most recent output', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-transport')
    const cap = 512 * 1024
    const handle = registerEagerPtyBuffer('pty-restored', vi.fn())

    // 800 KB of chunks exceeds the 512 KB cap; earliest chunks drop while the prompt-bearing tail is kept.
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
      // Why: Array.shift() per trim reindexed the buffer, making many small chunks quadratic.
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

    // Why: eager bytes carry DA1-style query sequences; onData bypasses the replay guard so xterm auto-replies, leaking input.
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

    // Why: title/control frames restore metadata but don't redraw, so clearing before them would erase persisted scrollback.
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

    // Why: OSC 9999 is stripped before xterm; a raw status frame must not clear restored scrollback and replay nothing.
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

    // Why: restored scrollback may already be in xterm before attach; an empty eager buffer must not erase it.
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

    // Why: a live PTY can have an eager handle before any bytes arrive; clearing would destroy scrollback restored at mount.
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

    // Why: alternate-screen snapshots already fill the viewport, so emitting the clear would erase restored content.
    const clear = '\x1b[2J\x1b[3J\x1b[H'
    expect(onReplayData.mock.calls).toEqual([[bufferedPayload, { clearBeforeReplay: false }]])
    expect(onReplayData).not.toHaveBeenCalledWith(clear)
    expect(onDataCallback).not.toHaveBeenCalledWith(clear)
  })
})
