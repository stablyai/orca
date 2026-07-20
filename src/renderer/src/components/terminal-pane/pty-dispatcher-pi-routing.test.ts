// Why: reproduce the renderer Pi spinner pipeline (pty:data IPC → onTitleChange); electron verification showed frames arrive but the store never sees "⠋ Pi".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ESC = '\x1b'
const BEL = '\x07'
const workingFrame = (frame: string): string => `${ESC}]0;${frame} π - cwd${BEL}`
const idleTitle = (): string => `${ESC}]0;π - cwd${BEL}`

function flushPtySideEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('dispatcher → transport → onTitleChange for Pi spinner', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  // The singleton dispatcher subscribes one global onData callback; we capture it to simulate main delivering IPC events directly.
  let dispatcherCallback:
    | ((payload: { id: string; data: string; rawLength?: number; background?: boolean }) => void)
    | null = null
  let exitDispatcherCallback: ((payload: { id: string; code: number }) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    dispatcherCallback = null
    exitDispatcherCallback = null
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: 'pty-pi' }),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          ackData: vi.fn(),
          rendererDispatcherReady: vi.fn(),
          onData: vi.fn(
            (
              cb: (payload: {
                id: string
                data: string
                rawLength?: number
                background?: boolean
              }) => void
            ) => {
              // Only the first subscriber wins in production (ensurePtyDispatcher's ptyDispatcherAttached guard), so capture the first callback and ignore the rest.
              if (!dispatcherCallback) {
                dispatcherCallback = cb
              }
              return () => {}
            }
          ),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn((cb: (payload: { id: string; code: number }) => void) => {
            if (!exitDispatcherCallback) {
              exitDispatcherCallback = cb
            }
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

  it('ACKs PTY data after dispatcher consumers accept the chunk', async () => {
    const { ensurePtyDispatcher, ptyDataHandlers } = await import('./pty-dispatcher')
    const handler = vi.fn()

    ensurePtyDispatcher()
    ptyDataHandlers.set('pty-pi', handler)

    dispatcherCallback?.({ id: 'pty-pi', data: 'chunk', rawLength: 10, background: true } as never)

    expect(handler).toHaveBeenCalledWith('chunk', { rawLength: 10, background: true })
    expect(window.api.pty.ackData).toHaveBeenCalledWith('pty-pi', 10, 10)
    ptyDataHandlers.delete('pty-pi')
  })

  it('signals main that the pty:data listener is live exactly once per page load', async () => {
    // Why: main gates all pty sends on this handshake, so a silent no-op would stall delivery until the 10s watchdog; assert it fires exactly once.
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')

    ensurePtyDispatcher()
    ensurePtyDispatcher()

    expect(window.api.pty.rendererDispatcherReady).toHaveBeenCalledTimes(1)
  })

  it('routes Pi OSC title frames from pty:data → onTitleChange via the dispatcher', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    expect(dispatcherCallback).not.toBeNull()

    // Simulate main firing pty:data IPC — dispatcher routes to ptyDataHandlers.get('pty-pi'), the same path a real Pi session uses.
    dispatcherCallback?.({ id: 'pty-pi', data: idleTitle() })
    dispatcherCallback?.({ id: 'pty-pi', data: workingFrame('⠋') })
    dispatcherCallback?.({ id: 'pty-pi', data: workingFrame('⠙') })
    dispatcherCallback?.({ id: 'pty-pi', data: idleTitle() })
    await flushPtySideEffects()

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    expect(seenTitles).toContain('⠋ Pi')

    transport.disconnect()
  })

  it('pipeline survives a chunk carrying shell output interleaved with spinner frames', async () => {
    // Why: node-pty's 8ms batching packs multiple OSC titles + body into one chunk; the handler takes the LAST title, which must still surface working frames.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    dispatcherCallback?.({
      id: 'pty-pi',
      data: `assistant output line 1\r\n${workingFrame('⠋')}more body text`
    })
    await flushPtySideEffects()

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    expect(seenTitles).toContain('⠋ Pi')

    transport.disconnect()
  })

  it('attach()-flow pipeline delivers working frames to onTitleChange', async () => {
    // Why: reattach uses attach() not connect(); if handler registration drifted between them, remounted Pi sessions would stop emitting spinner signals.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    transport.attach({ existingPtyId: 'pty-pi', callbacks: {} })

    // attach()'s eager-buffer replay can flush initial titles; only assert on frames pushed after attach resolves.
    onTitleChange.mockClear()

    dispatcherCallback?.({ id: 'pty-pi', data: workingFrame('⠋') })
    await flushPtySideEffects()

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    expect(seenTitles).toContain('⠋ Pi')

    transport.disconnect()
  })

  it('reproduces "Pi is idle" state: after working→idle, onTitleChange ends on Pi', async () => {
    // Why: bug shows the store stuck at idle "Pi" while working — assert both working and idle labels reach onTitleChange, in order.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    dispatcherCallback?.({ id: 'pty-pi', data: idleTitle() })
    dispatcherCallback?.({ id: 'pty-pi', data: workingFrame('⠋') })
    dispatcherCallback?.({ id: 'pty-pi', data: workingFrame('⠙') })
    dispatcherCallback?.({ id: 'pty-pi', data: idleTitle() })
    await flushPtySideEffects()

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    const workingIdx = seenTitles.indexOf('⠋ Pi')
    const finalIdleIdx = seenTitles.lastIndexOf('Pi')
    expect(workingIdx).toBeGreaterThanOrEqual(0)
    expect(finalIdleIdx).toBeGreaterThan(workingIdx)

    transport.disconnect()
  })

  // Why: regression for cursor's "solid after 500ms" bug — cursor re-emits its bare native title mid-turn; it must not overwrite the synthesized spinner frame.
  it('drops cursor-agent native "Cursor Agent" title so it cannot overwrite the synthesized spinner', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    // Realistic interleave: synthesized working frame, cursor's bare native title, next spinner frame, etc.
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;⠋ Cursor Agent${BEL}` })
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;Cursor Agent${BEL}` })
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;⠙ Cursor Agent${BEL}` })
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;Cursor Agent${BEL}` })
    await flushPtySideEffects()

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    expect(seenTitles).not.toContain('Cursor Agent')
    expect(seenTitles).toContain('⠋ Cursor Agent')
    expect(seenTitles).toContain('⠙ Cursor Agent')

    transport.disconnect()
  })

  it('still surfaces the synthesized "Cursor ready" idle title after working', async () => {
    // Why: the bare-title drop must not also catch the decorated "Cursor ready" done frame Orca synthesizes on the stop hook.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;⠋ Cursor Agent${BEL}` })
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;Cursor Agent${BEL}` })
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;Cursor ready${BEL}${BEL}` })
    await flushPtySideEffects()

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    expect(seenTitles).toContain('⠋ Cursor Agent')
    expect(seenTitles).toContain('Cursor ready')

    transport.disconnect()
  })

  it('surfaces synthesized "Codex ready" idle titles after Codex spinner titles', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({ onTitleChange })
    await transport.connect({ url: '', callbacks: {} })

    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;\u280b Codex${BEL}` })
    dispatcherCallback?.({ id: 'pty-pi', data: `${ESC}]0;Codex ready${BEL}` })
    await flushPtySideEffects()

    const seenTitles = onTitleChange.mock.calls.map((c) => c[0])
    expect(seenTitles).toContain('\u280b Codex')
    expect(seenTitles).toContain('Codex ready')

    transport.disconnect()
  })

  it('replays PTY data that arrives before connect() registers the pane handler', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onData = vi.fn()
    let resolveSpawn: (value: { id: string }) => void = () => {}

    ;(window.api.pty.spawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve
      })
    )

    const transport = createIpcPtyTransport()
    const connectPromise = transport.connect({ url: '', callbacks: { onData } })

    dispatcherCallback?.({ id: 'pty-early', data: 'setup starts here\r\n', rawLength: 19 })
    expect(onData).not.toHaveBeenCalled()
    expect(window.api.pty.ackData).toHaveBeenCalledWith('pty-early', 19, 19)

    resolveSpawn({ id: 'pty-early' })
    await connectPromise

    expect(onData).toHaveBeenCalledWith('setup starts here\r\n', { rawLength: 19 })

    transport.disconnect()
  })

  it('preserves buffered live-session data when reconnect re-admits a consumed id', async () => {
    const { consumePreHandlerPtyState } = await import('./pty-pre-handler-buffer')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const onData = vi.fn()

    ensurePtyDispatcher()
    consumePreHandlerPtyState('pty-persisted')
    dispatcherCallback?.({ id: 'pty-persisted', data: 'live before pane\r\n', rawLength: 18 })
    ;(window.api.pty.spawn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'pty-persisted',
      isReattach: true
    })

    const transport = createIpcPtyTransport()
    await transport.connect({
      url: '',
      sessionId: 'pty-persisted',
      callbacks: { onData }
    })

    expect(onData).toHaveBeenCalledWith('live before pane\r\n', { rawLength: 18 })
    transport.disconnect()
  })

  it('replays pre-handler PTY data before a pre-handler exit', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const events: string[] = []
    let resolveSpawn: (value: { id: string }) => void = () => {}

    ;(window.api.pty.spawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve
      })
    )

    const cleanupError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const transport = createIpcPtyTransport({
      onPtyExit: () => {
        throw new Error('pre-attach cleanup failed')
      }
    })
    const connectPromise = transport.connect({
      url: '',
      callbacks: {
        onData: (data) => events.push(`data:${data}`),
        onExit: (code) => events.push(`exit:${code}`)
      }
    })

    dispatcherCallback?.({ id: 'pty-fast-exit', data: 'last line\r\n', rawLength: 11 })
    exitDispatcherCallback?.({ id: 'pty-fast-exit', code: 3 })
    resolveSpawn({ id: 'pty-fast-exit' })
    const connectResult = await connectPromise

    expect(events).toEqual(['data:last line\r\n', 'exit:3'])
    expect(connectResult).toEqual({ id: 'pty-fast-exit', exitedBeforeAttach: true })
    expect(cleanupError).toHaveBeenCalled()

    exitDispatcherCallback?.({ id: 'pty-fast-exit', code: 4 })
    const duplicateExit = vi.fn()
    const { drainPreHandlerPtyExit } = await import('./pty-pre-handler-buffer')
    drainPreHandlerPtyExit('pty-fast-exit', duplicateExit)
    expect(duplicateExit).not.toHaveBeenCalled()
  })

  it('finalizes a throwing primary exit and still delivers every sidecar', async () => {
    const { ensurePtyDispatcher, ptyExitHandlers, subscribeToPtyExit } =
      await import('./pty-dispatcher')
    const primary = vi.fn(() => {
      throw new Error('primary exit failed')
    })
    const firstSidecar = vi.fn(() => {
      throw new Error('sidecar exit failed')
    })
    const secondSidecar = vi.fn()

    ensurePtyDispatcher()
    ptyExitHandlers.set('pty-throwing-exit', primary)
    subscribeToPtyExit('pty-throwing-exit', firstSidecar)
    subscribeToPtyExit('pty-throwing-exit', secondSidecar)

    expect(() => exitDispatcherCallback?.({ id: 'pty-throwing-exit', code: 9 })).toThrow(
      'primary exit failed'
    )
    expect(firstSidecar).toHaveBeenCalledWith(9, { hadPrimary: true })
    expect(secondSidecar).toHaveBeenCalledWith(9, { hadPrimary: true })

    expect(() => exitDispatcherCallback?.({ id: 'pty-throwing-exit', code: 10 })).not.toThrow()
    expect(primary).toHaveBeenCalledTimes(1)
    const duplicateExit = vi.fn()
    const { drainPreHandlerPtyExit } = await import('./pty-pre-handler-buffer')
    drainPreHandlerPtyExit('pty-throwing-exit', duplicateExit)
    expect(duplicateExit).not.toHaveBeenCalled()
  })
})
