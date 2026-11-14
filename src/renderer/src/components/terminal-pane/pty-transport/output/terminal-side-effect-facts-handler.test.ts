import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSideEffectBatch } from '../../../../../../shared/terminal/output/terminal-side-effect-facts'
import {
  _dispatchTerminalSideEffectBatchForTest,
  _resetTerminalSideEffectFactConsumersForTest,
  registerTerminalSideEffectFactConsumer,
  type TerminalSideEffectFactConsumerCallbacks
} from './terminal-side-effect-facts-handler'

const PTY_ID = 'wt-1#1'

function createCallbackRecorder(): {
  callbacks: TerminalSideEffectFactConsumerCallbacks
  events: unknown[][]
} {
  const events: unknown[][] = []
  return {
    events,
    callbacks: {
      onTitleChange: (normalizedTitle, rawTitle) =>
        events.push(['title', normalizedTitle, rawTitle]),
      onBell: () => events.push(['bell']),
      onAgentBecameIdle: (title) => events.push(['idle', title]),
      onAgentBecameWorking: () => events.push(['working']),
      onAgentExited: () => events.push(['exited'])
    }
  }
}

function batch(
  facts: TerminalSideEffectBatch['facts'],
  options: Partial<TerminalSideEffectBatch> = {}
): TerminalSideEffectBatch {
  return { ptyId: PTY_ID, seq: 0, facts, ...options }
}

describe('registerTerminalSideEffectFactConsumer', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    _resetTerminalSideEffectFactConsumersForTest()
    delete (globalThis as { window?: unknown }).window
  })

  afterEach(() => {
    _resetTerminalSideEffectFactConsumersForTest()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('applies only title facts from replay batches — no attention replay', () => {
    const { callbacks, events } = createCallbackRecorder()
    registerTerminalSideEffectFactConsumer({ ptyId: PTY_ID, callbacks })

    _dispatchTerminalSideEffectBatchForTest(
      batch(
        [
          { kind: 'title', normalizedTitle: '✳ Claude', rawTitle: '✳ Claude' },
          { kind: 'bell' },
          { kind: 'agent-idle', title: '✳ Claude' }
        ],
        { replay: true, seq: 10 }
      )
    )

    expect(events).toEqual([['title', '✳ Claude', '✳ Claude']])
  })

  it('drops a replay title not newer than the last applied live title', () => {
    const { callbacks, events } = createCallbackRecorder()
    registerTerminalSideEffectFactConsumer({ ptyId: PTY_ID, callbacks })

    _dispatchTerminalSideEffectBatchForTest(
      batch([{ kind: 'title', normalizedTitle: 'live', rawTitle: 'live' }], { seq: 20 })
    )
    _dispatchTerminalSideEffectBatchForTest(
      batch([{ kind: 'title', normalizedTitle: 'stale', rawTitle: 'stale' }], {
        replay: true,
        seq: 20
      })
    )
    _dispatchTerminalSideEffectBatchForTest(
      batch([{ kind: 'title', normalizedTitle: 'newer', rawTitle: 'newer' }], {
        replay: true,
        seq: 21
      })
    )

    expect(events).toEqual([
      ['title', 'live', 'live'],
      ['title', 'newer', 'newer']
    ])
  })

  it('keeps exactly one consumer per PTY: a new registration replaces the old', () => {
    const first = createCallbackRecorder()
    const second = createCallbackRecorder()
    const disposeFirst = registerTerminalSideEffectFactConsumer({
      ptyId: PTY_ID,
      callbacks: first.callbacks
    })
    registerTerminalSideEffectFactConsumer({ ptyId: PTY_ID, callbacks: second.callbacks })

    _dispatchTerminalSideEffectBatchForTest(batch([{ kind: 'bell' }]))
    // A stale registration's dispose must not evict the live consumer.
    disposeFirst()
    _dispatchTerminalSideEffectBatchForTest(batch([{ kind: 'bell' }]))

    expect(first.events).toEqual([])
    expect(second.events).toEqual([['bell'], ['bell']])
  })

  it('hands off facts emitted between the parked watcher unregistering and the pane registering', () => {
    // Reveal unregisters watchers before async pane registration; title-only replay cannot recover live bells/completions lost in that gap.
    const watcher = createCallbackRecorder()
    const disposeWatcher = registerTerminalSideEffectFactConsumer({
      ptyId: PTY_ID,
      callbacks: watcher.callbacks
    })
    disposeWatcher()

    const events: unknown[][] = []
    _dispatchTerminalSideEffectBatchForTest(
      batch([{ kind: 'bell' }, { kind: 'command-code-done', prompt: 'Fix the spinner' }], {
        seq: 7
      })
    )
    // A PTY that never had a consumer stays dropped — no buffer was opened.
    _dispatchTerminalSideEffectBatchForTest(batch([{ kind: 'bell' }], { ptyId: 'never-consumed' }))

    expect(events).toEqual([])
    expect(watcher.events).toEqual([])

    const neverConsumed = createCallbackRecorder()
    registerTerminalSideEffectFactConsumer({
      ptyId: 'never-consumed',
      callbacks: neverConsumed.callbacks
    })
    expect(neverConsumed.events).toEqual([])

    const dispose = registerTerminalSideEffectFactConsumer({
      ptyId: PTY_ID,
      callbacks: {
        onBell: () => events.push(['bell']),
        onCommandCodeDone: (prompt) => events.push(['cc-done', prompt])
      }
    })

    expect(events).toEqual([['bell'], ['cc-done', 'Fix the spinner']])
    expect(watcher.events).toEqual([])

    // Drained exactly once: a later registration gets nothing.
    dispose()
    const later: unknown[][] = []
    registerTerminalSideEffectFactConsumer({
      ptyId: PTY_ID,
      callbacks: {
        onBell: () => later.push(['bell']),
        onCommandCodeDone: (prompt) => later.push(['cc-done', prompt])
      }
    })

    expect(later).toEqual([])
  })

  it('drains the handoff buffer before the register snapshot, so the replay is stale', async () => {
    // Drain live titles before the async snapshot so sequence comparison rejects its stale predecessor.
    const snapshot = batch([{ kind: 'title', normalizedTitle: 'snapshot', rawTitle: 'snapshot' }], {
      replay: true,
      seq: 20
    })
    ;(globalThis as { window: unknown }).window = {
      api: { pty: { getSideEffectSnapshot: vi.fn(async () => snapshot) } }
    }

    const dispose = registerTerminalSideEffectFactConsumer({
      ptyId: PTY_ID,
      callbacks: createCallbackRecorder().callbacks
    })
    dispose()
    _dispatchTerminalSideEffectBatchForTest(
      batch([{ kind: 'title', normalizedTitle: 'live', rawTitle: 'live' }], { seq: 20 })
    )

    const { callbacks, events } = createCallbackRecorder()
    registerTerminalSideEffectFactConsumer({
      ptyId: PTY_ID,
      callbacks,
      restoreTitleOnRegister: true
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(events).toEqual([['title', 'live', 'live']])
  })

  it('applies the title snapshot on register unless the registration was replaced', async () => {
    let resolveSnapshot: (value: TerminalSideEffectBatch | null) => void = () => {}
    const getSideEffectSnapshot = vi.fn(
      () =>
        new Promise<TerminalSideEffectBatch | null>((resolve) => {
          resolveSnapshot = resolve
        })
    )
    ;(globalThis as { window: unknown }).window = {
      api: { pty: { getSideEffectSnapshot } }
    }

    const first = createCallbackRecorder()
    registerTerminalSideEffectFactConsumer({
      ptyId: PTY_ID,
      callbacks: first.callbacks,
      restoreTitleOnRegister: true
    })
    expect(getSideEffectSnapshot).toHaveBeenCalledWith(PTY_ID)

    // Slow snapshots must not reach replacement registrations.
    const second = createCallbackRecorder()
    registerTerminalSideEffectFactConsumer({ ptyId: PTY_ID, callbacks: second.callbacks })
    resolveSnapshot(
      batch([{ kind: 'title', normalizedTitle: 'restored', rawTitle: 'restored' }], {
        replay: true,
        seq: 5
      })
    )
    await Promise.resolve()

    expect(first.events).toEqual([])
    expect(second.events).toEqual([])
  })
})
