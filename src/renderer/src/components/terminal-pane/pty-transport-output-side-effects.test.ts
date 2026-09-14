import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushPtySideEffects,
  installIpcPtyWindow,
  restorePtySpecWindow
} from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    onData = null
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        onData = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
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
    // Why: a restore marker means bytes dropped, so a carried partial OSC-9999 prefix would eat the next chunk's head.
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
      // Why: the literal is the pane's identity once (#10258); the redraw repeats stay ignored.
      expect(onTitleChange.mock.calls).toEqual([['Cursor Agent', 'Cursor Agent']])
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

  it('bounds the deferred side-effect queue under a stalled drain, keeping the newest title and a pending bell', async () => {
    vi.useFakeTimers()
    try {
      const { createPtyOutputProcessor, MAX_PENDING_PTY_SIDE_EFFECTS } =
        await import('./pty-transport')
      const onTitleChange = vi.fn()
      const onBell = vi.fn()
      const processor = createPtyOutputProcessor({ onTitleChange, onBell })
      const callbacks = { onData: vi.fn() }
      const total = MAX_PENDING_PTY_SIDE_EFFECTS * 4

      // Why: the bell is queued first so the cap must evict it — the latch has to survive onto a newer entry.
      processor.processData('\x07', callbacks)
      for (let i = 0; i < total / 2; i++) {
        processor.processData(`\x1b]0;cap-title-${i}\x07`, callbacks)
      }
      // Why: a paused drain (background shutdown window) must not disable the bound either.
      processor.pausePendingSideEffects()
      for (let i = total / 2; i < total; i++) {
        processor.processData(`\x1b]0;cap-title-${i}\x07`, callbacks)
      }

      expect(onTitleChange).not.toHaveBeenCalled()
      processor.flushPendingSideEffects()

      // Why: exactly the cap survives — every older title was evicted, never applied.
      expect(onTitleChange).toHaveBeenCalledTimes(MAX_PENDING_PTY_SIDE_EFFECTS)
      expect(onTitleChange).toHaveBeenLastCalledWith(
        `cap-title-${total - 1}`,
        `cap-title-${total - 1}`
      )
      expect(onBell).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapses evicted agent-status payloads onto the survivor, keeping the newest', async () => {
    vi.useFakeTimers()
    try {
      const {
        createPtyOutputProcessor,
        MAX_PENDING_PTY_SIDE_EFFECTS,
        MAX_EVICTED_AGENT_STATUS_PAYLOAD_CARRY
      } = await import('./pty-transport')
      const onAgentStatus = vi.fn()
      const processor = createPtyOutputProcessor({ onAgentStatus })
      const callbacks = { onData: vi.fn() }
      const total = MAX_PENDING_PTY_SIDE_EFFECTS * 2

      for (let i = 0; i < total; i++) {
        processor.processData(
          `\x1b]9999;{"state":"working","prompt":"cap-status-${i}"}\x07`,
          callbacks
        )
      }
      processor.flushPendingSideEffects()

      const delivered = onAgentStatus.mock.calls.map(([payload]) => payload.prompt)
      expect(delivered.length).toBeLessThanOrEqual(
        MAX_PENDING_PTY_SIDE_EFFECTS + MAX_EVICTED_AGENT_STATUS_PAYLOAD_CARRY
      )
      expect(delivered.at(-1)).toBe(`cap-status-${total - 1}`)
      // Why: eviction collapse must preserve chronological delivery order.
      expect(delivered).toEqual(
        [...delivered].sort((a, b) => Number(a.slice(11)) - Number(b.slice(11)))
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers every side effect in order when the queue stays below the cap', async () => {
    vi.useFakeTimers()
    try {
      const { createPtyOutputProcessor } = await import('./pty-transport')
      const onTitleChange = vi.fn()
      const onBell = vi.fn()
      const onAgentStatus = vi.fn()
      const processor = createPtyOutputProcessor({ onTitleChange, onBell, onAgentStatus })
      const callbacks = { onData: vi.fn() }

      processor.processData('\x07', callbacks)
      for (let i = 0; i < 100; i++) {
        processor.processData(`\x1b]0;under-cap-${i}\x07`, callbacks)
      }
      processor.processData('\x1b]9999;{"state":"done","prompt":"done"}\x07', callbacks)
      await vi.runAllTimersAsync()

      expect(onBell).toHaveBeenCalledTimes(1)
      expect(onTitleChange).toHaveBeenCalledTimes(100)
      expect(onTitleChange).toHaveBeenLastCalledWith('under-cap-99', 'under-cap-99')
      expect(onAgentStatus).toHaveBeenCalledWith({ state: 'done', prompt: 'done' })
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

  it('fires onBell for bare BELs but ignores BELs inside OSC sequences', async () => {
    // Why: OSC titles end with a BEL, so the detector must ignore in-OSC BELs or every title change would ring spuriously.
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
})
