// @vitest-environment happy-dom
import { describe, expect, it, vi, type Mock } from 'vitest'

import { executeTerminalPastePlan, planTerminalPaste } from './terminal-paste-coordinator'
import type { TerminalPasteExecutionResult } from './terminal-paste-model'
import {
  createDeferredPasteFocusInHandler,
  createDeferredTerminalPasteQueue,
  isDeferrablePasteFocusCancellation,
  isFocusInsideOtherPane,
  resolveDeferredPasteFocusIn,
  TERMINAL_DEFERRED_PASTE_TIMEOUT_MS,
  type DeferredTerminalPaste,
  type DeferredTerminalPasteDropCause
} from './terminal-deferred-paste'

type Timer = { id: number; callback: () => void; ms: number }

function createTimerHarness(): {
  setTimer: (callback: () => void, ms: number) => number
  clearTimer: (id: number) => void
  fire: (id?: number) => void
  live: () => Timer[]
} {
  const timers = new Map<number, Timer>()
  let nextId = 1
  return {
    setTimer: (callback, ms) => {
      const id = nextId
      nextId += 1
      timers.set(id, { id, callback, ms })
      return id
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
    fire: (id) => {
      const timer = id === undefined ? [...timers.values()][0] : timers.get(id)
      if (!timer) {
        throw new Error(`no live timer ${id ?? '(first)'}`)
      }
      timers.delete(timer.id)
      timer.callback()
    },
    live: () => [...timers.values()]
  }
}

const entry = (overrides: Partial<DeferredTerminalPaste> = {}): DeferredTerminalPaste => ({
  paneId: 1,
  leafId: 'leaf-a',
  source: 'keyboard',
  text: 'dictated paragraph',
  ...overrides
})

describe('deferred terminal paste queue', () => {
  it('hands the payload back to the pane it was aimed at', () => {
    const timers = createTimerHarness()
    const onExpire = vi.fn()
    const queue = createDeferredTerminalPasteQueue({ onExpire, ...timers })

    queue.defer(entry())

    expect(queue.isPending()).toBe(true)
    expect(queue.claim(1, 'leaf-a')).toEqual(entry())
    expect(queue.isPending()).toBe(false)
    // The deadline must be disarmed by the claim, not left to fire later.
    expect(timers.live()).toEqual([])
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('refuses to hand the payload to a different pane or leaf', () => {
    const timers = createTimerHarness()
    const queue = createDeferredTerminalPasteQueue({ onExpire: vi.fn(), ...timers })

    queue.defer(entry())

    expect(queue.claim(2, 'leaf-a')).toBe(null)
    expect(queue.claim(1, 'leaf-b')).toBe(null)
    expect(queue.isPending()).toBe(true)
  })

  it('drops the payload and signals the user when focus never comes back', () => {
    const timers = createTimerHarness()
    const onExpire = vi.fn()
    const queue = createDeferredTerminalPasteQueue({ onExpire, ...timers })

    queue.defer(entry())
    expect(timers.live()[0]?.ms).toBe(TERMINAL_DEFERRED_PASTE_TIMEOUT_MS)

    timers.fire()

    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith(entry())
    // Bounded: the clipboard text is not retained past the deadline, and a late
    // focus return cannot make it land.
    expect(queue.isPending()).toBe(false)
    expect(queue.claim(1, 'leaf-a')).toBe(null)
  })

  it('does not retain the payload when the expiry notifier throws', () => {
    const timers = createTimerHarness()
    const queue = createDeferredTerminalPasteQueue({
      onExpire: () => {
        throw new Error('toast surface gone')
      },
      ...timers
    })

    queue.defer(entry())
    expect(() => timers.fire()).toThrow('toast surface gone')

    expect(queue.isPending()).toBe(false)
    expect(queue.claim(1, 'leaf-a')).toBe(null)
  })

  it('lets a newer paste supersede the pending one without a stray expiry', () => {
    const timers = createTimerHarness()
    const onExpire = vi.fn()
    const queue = createDeferredTerminalPasteQueue({ onExpire, ...timers })

    queue.defer(entry({ text: 'first' }))
    queue.defer(entry({ text: 'second' }))

    expect(timers.live()).toHaveLength(1)
    timers.fire()
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith(entry({ text: 'second' }))
  })

  it('carries a payload larger than the 1024-byte typed-command cap intact', () => {
    const timers = createTimerHarness()
    const queue = createDeferredTerminalPasteQueue({ onExpire: vi.fn(), ...timers })
    // Line-bounded so the payload is never at the mercy of a TTY MAX_CANON limit.
    const large = Array.from({ length: 40 }, (_, index) => `line-${index}-${'x'.repeat(60)}`).join(
      '\n'
    )
    expect(new TextEncoder().encode(large).byteLength).toBeGreaterThan(1024)

    queue.defer(entry({ text: large }))
    const claimed = queue.claim(1, 'leaf-a')

    expect(claimed?.text).toBe(large)
    expect(new TextEncoder().encode(claimed?.text ?? '').byteLength).toBe(
      new TextEncoder().encode(large).byteLength
    )
  })

  // STA-5272 review: Electron leaves `backgroundThrottling` on, so a hidden
  // renderer's timers are aligned to 1s and, after 5 minutes hidden, to 1-minute
  // buckets. The deadline timer can therefore still be pending long past 2s while
  // restoring the window fires focusin first — landing the paste minutes later.
  // The wall clock, not the timer, has to be what bounds the payload.
  it('refuses a claim made after the deadline even if the timer has not fired yet', () => {
    const timers = createTimerHarness()
    const onExpire = vi.fn()
    let nowMs = 1_000
    const queue = createDeferredTerminalPasteQueue({
      onExpire,
      now: () => nowMs,
      ...timers
    })

    queue.defer(entry())
    // The window was hidden; the timer is still queued, unfired.
    nowMs += TERMINAL_DEFERRED_PASTE_TIMEOUT_MS + 1
    expect(timers.live()).toHaveLength(1)

    expect(queue.claim(1, 'leaf-a')).toBe(null)
    // and the user is told rather than silently robbed of the paste
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(queue.isPending()).toBe(false)
    expect(timers.live()).toEqual([])
  })

  // The deadline is read at three entry points; `claim` is only one of them. A
  // throttled timer means an expired payload must not answer as pending to any of
  // them, or the focusin path resolves against a target it can no longer deliver to.
  it('reports nothing pending once the deadline passes, timer fired or not', () => {
    const timers = createTimerHarness()
    const onExpire = vi.fn()
    let nowMs = 1_000
    const queue = createDeferredTerminalPasteQueue({ onExpire, now: () => nowMs, ...timers })

    queue.defer(entry())
    expect(queue.pendingTarget()).toEqual({ paneId: 1, leafId: 'leaf-a' })
    nowMs += TERMINAL_DEFERRED_PASTE_TIMEOUT_MS + 1

    expect(queue.pendingTarget()).toBe(null)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(timers.live()).toEqual([])
  })

  it('reports not-pending on the deadline even when nothing claims it', () => {
    const timers = createTimerHarness()
    const onExpire = vi.fn()
    let nowMs = 1_000
    const queue = createDeferredTerminalPasteQueue({ onExpire, now: () => nowMs, ...timers })

    queue.defer(entry())
    expect(queue.isPending()).toBe(true)
    nowMs += TERMINAL_DEFERRED_PASTE_TIMEOUT_MS

    expect(queue.isPending()).toBe(false)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('still honours a claim made inside the deadline', () => {
    const timers = createTimerHarness()
    const onExpire = vi.fn()
    let nowMs = 1_000
    const queue = createDeferredTerminalPasteQueue({ onExpire, now: () => nowMs, ...timers })

    queue.defer(entry())
    nowMs += TERMINAL_DEFERRED_PASTE_TIMEOUT_MS - 1

    expect(queue.claim(1, 'leaf-a')).toEqual(entry())
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('drops the payload on dispose without firing the expiry signal', () => {
    const timers = createTimerHarness()
    const onExpire = vi.fn()
    const queue = createDeferredTerminalPasteQueue({ onExpire, ...timers })

    queue.defer(entry())
    queue.dispose()

    expect(queue.isPending()).toBe(false)
    expect(timers.live()).toEqual([])
    expect(onExpire).not.toHaveBeenCalled()
  })
})

// The executor's own result goes in whole: a caller that could spread three fields
// out of it could pass a literal `chunksWritten: 0` over a partial write.
const executionResult = (
  overrides: Partial<TerminalPasteExecutionResult> = {}
): TerminalPasteExecutionResult => ({
  status: 'cancelled',
  reason: 'stale-target',
  chunksWritten: 0,
  diagnostic: 'paste cancelled',
  durationMs: 3,
  ...overrides
})

describe('isDeferrablePasteFocusCancellation', () => {
  const base = {
    execution: executionResult(),
    targetMounted: true,
    focusMovedToOtherPane: false
  }

  it('defers only a focus-loss cancellation whose pane is still the live target', () => {
    expect(isDeferrablePasteFocusCancellation(base)).toBe(true)
  })

  it('refuses to defer when focus moved to a different pane', () => {
    // The wrong-target case the guard actually exists for.
    expect(isDeferrablePasteFocusCancellation({ ...base, focusMovedToOtherPane: true })).toBe(false)
  })

  it('refuses to defer when the target is gone', () => {
    expect(isDeferrablePasteFocusCancellation({ ...base, targetMounted: false })).toBe(false)
  })

  // Ablation gap: every other case here is already excluded by the reason check,
  // so the status conjunct needs a reason it would otherwise let through. Today
  // the executor only pairs 'rejected' with 'payload-too-large' (see
  // terminal-paste-coordinator planning), so this pins the contract, not a
  // currently reachable pairing.
  it('refuses to defer anything that is not a cancellation, whatever the reason says', () => {
    expect(
      isDeferrablePasteFocusCancellation({
        ...base,
        execution: executionResult({ status: 'rejected' })
      })
    ).toBe(false)
    expect(
      isDeferrablePasteFocusCancellation({
        ...base,
        execution: executionResult({ status: 'pasted' })
      })
    ).toBe(false)
  })

  it('refuses to defer non-focus cancellations and rejections', () => {
    expect(
      isDeferrablePasteFocusCancellation({
        ...base,
        execution: executionResult({ reason: 'target-disconnected' })
      })
    ).toBe(false)
    expect(
      isDeferrablePasteFocusCancellation({
        ...base,
        execution: executionResult({ reason: 'operation-timeout' })
      })
    ).toBe(false)
    expect(
      isDeferrablePasteFocusCancellation({
        ...base,
        execution: executionResult({ reason: undefined })
      })
    ).toBe(false)
    expect(
      isDeferrablePasteFocusCancellation({
        ...base,
        execution: executionResult({ status: 'rejected', reason: 'payload-too-large' })
      })
    ).toBe(false)
  })
})

describe('deferred paste focus resolution', () => {
  const buildPanes = (): {
    panes: { id: number; leafId: string; container: HTMLElement }[]
    focusable: (paneIndex: number) => HTMLElement
  } => {
    const root = document.createElement('div')
    document.body.append(root)
    const panes = [0, 1].map((index) => {
      const container = document.createElement('div')
      const helper = document.createElement('textarea')
      helper.className = 'xterm-helper-textarea'
      container.append(helper)
      root.append(container)
      return { id: index + 1, leafId: `leaf-${index}`, container }
    })
    return {
      panes,
      focusable: (paneIndex) => panes[paneIndex]!.container.firstElementChild as HTMLElement
    }
  }

  it('delivers the payload when focus returns to its own pane', () => {
    const { panes, focusable } = buildPanes()
    const queue = createDeferredTerminalPasteQueue({ onExpire: vi.fn(), ...createTimerHarness() })
    queue.defer(entry({ paneId: 1, leafId: 'leaf-0' }))

    const resolution = resolveDeferredPasteFocusIn({
      panes,
      focusedElement: focusable(0),
      queue
    })

    expect(resolution.action).toBe('deliver')
    expect(resolution.action === 'deliver' && resolution.entry.text).toBe('dictated paragraph')
    expect(queue.isPending()).toBe(false)
  })

  it('drops the payload when focus lands in a different pane', () => {
    const { panes, focusable } = buildPanes()
    const queue = createDeferredTerminalPasteQueue({ onExpire: vi.fn(), ...createTimerHarness() })
    queue.defer(entry({ paneId: 1, leafId: 'leaf-0' }))

    const resolution = resolveDeferredPasteFocusIn({
      panes,
      focusedElement: focusable(1),
      queue
    })

    expect(resolution.action).toBe('drop')
    expect(resolution.action === 'drop' && resolution.cause).toBe('focus-moved-to-other-pane')
    expect(resolution.action === 'drop' && resolution.entry?.text).toBe('dictated paragraph')
    expect(queue.isPending()).toBe(false)
  })

  it('ignores focus that lands outside every pane', () => {
    const { panes } = buildPanes()
    const outside = document.createElement('input')
    document.body.append(outside)
    const queue = createDeferredTerminalPasteQueue({ onExpire: vi.fn(), ...createTimerHarness() })
    queue.defer(entry({ paneId: 1, leafId: 'leaf-0' }))

    expect(resolveDeferredPasteFocusIn({ panes, focusedElement: outside, queue }).action).toBe(
      'ignore'
    )
    expect(queue.isPending()).toBe(true)
  })

  it('ignores focus movement when nothing is deferred', () => {
    const { panes, focusable } = buildPanes()
    const queue = createDeferredTerminalPasteQueue({ onExpire: vi.fn(), ...createTimerHarness() })

    expect(resolveDeferredPasteFocusIn({ panes, focusedElement: focusable(0), queue }).action).toBe(
      'ignore'
    )
  })
})

describe('isFocusInsideOtherPane', () => {
  it('separates the paste target from its split siblings', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const own = document.createElement('div')
    const sibling = document.createElement('div')
    const ownChild = document.createElement('textarea')
    const siblingChild = document.createElement('textarea')
    own.append(ownChild)
    sibling.append(siblingChild)
    root.append(own, sibling)
    const panes = [
      { id: 1, leafId: 'leaf-0', container: own },
      { id: 2, leafId: 'leaf-1', container: sibling }
    ]

    expect(isFocusInsideOtherPane({ panes, paneId: 1, focusedElement: ownChild })).toBe(false)
    expect(isFocusInsideOtherPane({ panes, paneId: 1, focusedElement: siblingChild })).toBe(true)
    expect(isFocusInsideOtherPane({ panes, paneId: 1, focusedElement: document.body })).toBe(false)
    expect(isFocusInsideOtherPane({ panes, paneId: 1, focusedElement: null })).toBe(false)
  })
})

// The pane's real focusin handler, driven by real DOM focus moves.
describe('deferred paste focusin handler', () => {
  const buildScene = (): {
    handler: () => void
    queue: ReturnType<typeof createDeferredTerminalPasteQueue>
    deliver: Mock<(pane: { id: number }, deferred: DeferredTerminalPaste) => void>
    onDropped: Mock<
      (deferred: DeferredTerminalPaste, cause: DeferredTerminalPasteDropCause) => void
    >
    onExpire: Mock<(deferred: DeferredTerminalPaste) => void>
    timers: ReturnType<typeof createTimerHarness>
    focusables: HTMLElement[]
    root: HTMLElement
  } => {
    document.body.innerHTML = ''
    const root = document.createElement('div')
    document.body.append(root)
    const panes = [0, 1].map((index) => {
      const container = document.createElement('div')
      const helper = document.createElement('textarea')
      helper.className = 'xterm-helper-textarea'
      container.append(helper)
      root.append(container)
      return { id: index + 1, leafId: `leaf-${index}`, container }
    })
    const timers = createTimerHarness()
    const onExpire = vi.fn<(deferred: DeferredTerminalPaste) => void>()
    const queue = createDeferredTerminalPasteQueue({ onExpire, ...timers })
    const deliver = vi.fn<(pane: { id: number }, deferred: DeferredTerminalPaste) => void>()
    const onDropped =
      vi.fn<(deferred: DeferredTerminalPaste, cause: DeferredTerminalPasteDropCause) => void>()
    const handler = createDeferredPasteFocusInHandler({
      queue,
      getPanes: () => panes,
      getFocusedElement: () => document.activeElement,
      deliver,
      onDropped
    })
    root.addEventListener('focusin', handler)
    return {
      handler,
      queue,
      deliver,
      onDropped,
      onExpire,
      timers,
      focusables: panes.map((pane) => pane.container.firstElementChild as HTMLElement),
      root
    }
  }

  it('lands the deferred payload when focus returns to the pane', () => {
    const scene = buildScene()
    scene.queue.defer(entry({ paneId: 1, leafId: 'leaf-0', text: 'a dictated paragraph' }))

    scene.focusables[0]!.focus()

    expect(scene.deliver).toHaveBeenCalledTimes(1)
    expect(scene.deliver.mock.calls[0]?.[0]?.id).toBe(1)
    expect(scene.deliver.mock.calls[0]?.[1]?.text).toBe('a dictated paragraph')
    expect(scene.onDropped).not.toHaveBeenCalled()
    expect(scene.queue.isPending()).toBe(false)
    expect(scene.timers.live()).toEqual([])
  })

  it('lands a payload larger than the 1024-byte typed-command cap without truncating it', () => {
    const scene = buildScene()
    const large = Array.from({ length: 40 }, (_, index) => `line-${index}-${'x'.repeat(60)}`).join(
      '\n'
    )
    expect(new TextEncoder().encode(large).byteLength).toBeGreaterThan(1024)
    scene.queue.defer(entry({ paneId: 1, leafId: 'leaf-0', text: large }))

    scene.focusables[0]!.focus()

    expect(scene.deliver.mock.calls[0]?.[1]?.text).toBe(large)
  })

  it('drops the payload with a signal when a different pane takes focus', () => {
    const scene = buildScene()
    scene.queue.defer(entry({ paneId: 1, leafId: 'leaf-0' }))

    scene.focusables[1]!.focus()

    expect(scene.deliver).not.toHaveBeenCalled()
    expect(scene.onDropped).toHaveBeenCalledTimes(1)
    expect(scene.onDropped.mock.calls[0]?.[1]).toBe('focus-moved-to-other-pane')
    expect(scene.queue.isPending()).toBe(false)
  })

  it('keeps the payload pending while focus has not come back yet, then expires it', () => {
    const scene = buildScene()
    scene.queue.defer(entry({ paneId: 1, leafId: 'leaf-0' }))
    const outside = document.createElement('input')
    document.body.append(outside)

    outside.focus()

    expect(scene.deliver).not.toHaveBeenCalled()
    expect(scene.onDropped).not.toHaveBeenCalled()
    expect(scene.queue.isPending()).toBe(true)

    scene.timers.fire()

    expect(scene.onExpire).toHaveBeenCalledTimes(1)
    // Bounded: focus coming back after the deadline must not fire a surprise paste.
    scene.focusables[0]!.focus()
    expect(scene.deliver).not.toHaveBeenCalled()
  })

  it('does nothing on ordinary focus moves when no paste is deferred', () => {
    const scene = buildScene()

    scene.focusables[0]!.focus()
    scene.focusables[1]!.focus()

    expect(scene.deliver).not.toHaveBeenCalled()
    expect(scene.onDropped).not.toHaveBeenCalled()
  })
})

// STA-5272 review: `stale-target` is not only a pre-write verdict. The chunked
// writer re-checks the target between chunks, so a focus move part-way through a
// large paste cancels with bytes already in the PTY. Deferring that payload and
// replaying it whole duplicates everything written before the cancel.
describe('partially written pastes are not deferrable', () => {
  const chunkedPlan = (text: string) =>
    planTerminalPaste({
      text,
      source: 'keyboard',
      target: {
        kind: 'terminal',
        paneId: 1,
        leafId: 'leaf-a',
        ptyId: 'pty-1',
        runtime: { platform: 'darwin', runtimeKey: 'local:darwin', kind: 'local' }
      },
      maxDirectBytes: 4,
      maxChunkBytes: 8
    })

  it('premise: the real executor cancels mid-write with bytes already in the pty', async () => {
    const writes: string[] = []
    let focusHeld = true

    const execution = await executeTerminalPastePlan(chunkedPlan('abcdefgh12345678zzzzzzzz'), {
      pasteText: () => {},
      writePty: (data) => {
        writes.push(data)
        return true
      },
      // Focus leaves the pane after the first chunk lands, exactly as a
      // dictation/overlay handoff does mid-paste.
      isTargetCurrent: () => {
        if (writes.length >= 1) {
          focusHeld = false
        }
        return focusHeld
      }
    })

    expect(execution.status).toBe('cancelled')
    expect(execution.reason).toBe('stale-target')
    expect(execution.chunksWritten).toBeGreaterThan(0)
    expect(writes.join('')).not.toBe('abcdefgh12345678zzzzzzzz')
  })

  // End to end on the real executor: the verdict is taken from the result object
  // the executor actually produced, never from fields re-stated by the caller.
  it('refuses to defer the real executor result of a partially written paste', async () => {
    const writes: string[] = []
    let focusHeld = true
    const execution = await executeTerminalPastePlan(chunkedPlan('abcdefgh12345678zzzzzzzz'), {
      pasteText: () => {},
      writePty: (data) => {
        writes.push(data)
        return true
      },
      isTargetCurrent: () => {
        if (writes.length >= 1) {
          focusHeld = false
        }
        return focusHeld
      }
    })

    expect(
      isDeferrablePasteFocusCancellation({
        execution,
        targetMounted: true,
        focusMovedToOtherPane: false
      })
    ).toBe(false)
  })

  it('still defers the real executor result of a paste cancelled before any write', async () => {
    const execution = await executeTerminalPastePlan(chunkedPlan('abcdefgh12345678zzzzzzzz'), {
      pasteText: () => {},
      writePty: () => {
        throw new Error('nothing may be written')
      },
      isTargetCurrent: () => false
    })

    expect(execution.chunksWritten).toBe(0)
    expect(
      isDeferrablePasteFocusCancellation({
        execution,
        targetMounted: true,
        focusMovedToOtherPane: false
      })
    ).toBe(true)
  })
})

// STA-5272 review: the pane the payload was aimed at can be closed while the
// payload waits. Nothing may be written anywhere, and the user has to be told
// now rather than after the full deadline, because the text is still retained.
describe('a deferred paste whose pane is destroyed before focus returns', () => {
  const buildScene = (): {
    panes: { id: number; leafId: string; container: HTMLElement }[]
    ptyWrites: string[]
    queue: ReturnType<typeof createDeferredTerminalPasteQueue>
    handler: () => void
    onDropped: Mock<
      (deferred: DeferredTerminalPaste, cause: DeferredTerminalPasteDropCause) => void
    >
    onExpire: Mock<(deferred: DeferredTerminalPaste) => void>
    outside: HTMLInputElement
  } => {
    document.body.innerHTML = ''
    const root = document.createElement('div')
    document.body.append(root)
    const panes = [0, 1].map((index) => {
      const container = document.createElement('div')
      const helper = document.createElement('textarea')
      helper.className = 'xterm-helper-textarea'
      container.append(helper)
      root.append(container)
      return { id: index + 1, leafId: `leaf-${index}`, container }
    })
    const outside = document.createElement('input')
    document.body.append(outside)
    const ptyWrites: string[] = []
    const onExpire = vi.fn<(deferred: DeferredTerminalPaste) => void>()
    const queue = createDeferredTerminalPasteQueue({ onExpire, ...createTimerHarness() })
    const onDropped =
      vi.fn<(deferred: DeferredTerminalPaste, cause: DeferredTerminalPasteDropCause) => void>()
    const handler = createDeferredPasteFocusInHandler({
      queue,
      getPanes: () => panes,
      getFocusedElement: () => document.activeElement,
      // The only thing delivery does in production is run the paste, which ends
      // in a PTY write; a spy that records nothing would hide a real write.
      deliver: (_pane, deferred) => ptyWrites.push(deferred.text),
      onDropped
    })
    return { panes, ptyWrites, queue, handler, onDropped, onExpire, outside }
  }

  it('drops the payload and tells the user when focus lands outside every pane', () => {
    const scene = buildScene()
    scene.queue.defer(entry({ paneId: 1, leafId: 'leaf-0', text: 'secret token' }))

    // The pane is closed: it is gone from the manager and out of the DOM.
    scene.panes[0]!.container.remove()
    scene.panes.splice(0, 1)
    scene.outside.focus()
    scene.handler()

    expect(scene.ptyWrites).toEqual([])
    expect(scene.onDropped).toHaveBeenCalledTimes(1)
    expect(scene.onDropped.mock.calls[0]?.[0]?.text).toBe('secret token')
    // Not the deadline copy: this pane was closed, and the toast has to say so.
    expect(scene.onDropped.mock.calls[0]?.[1]).toBe('target-pane-closed')
    // Retention: the clipboard text is released with the pane, not held to the deadline.
    expect(scene.queue.isPending()).toBe(false)
    expect(scene.onExpire).not.toHaveBeenCalled()
  })

  it('drops the payload and tells the user when focus lands in a surviving sibling', () => {
    const scene = buildScene()
    scene.queue.defer(entry({ paneId: 1, leafId: 'leaf-0' }))

    scene.panes[0]!.container.remove()
    scene.panes.splice(0, 1)
    ;(scene.panes[0]!.container.firstElementChild as HTMLElement).focus()
    scene.handler()

    expect(scene.ptyWrites).toEqual([])
    expect(scene.onDropped).toHaveBeenCalledTimes(1)
    expect(scene.onDropped.mock.calls[0]?.[1]).toBe('target-pane-closed')
    expect(scene.queue.isPending()).toBe(false)
  })

  it('leaves the payload alone while the pane manager reports no panes at all', () => {
    // A transiently empty manager during a re-render is not evidence the target
    // pane was closed; treating it as one would drop a healthy deferred paste.
    const scene = buildScene()
    scene.queue.defer(entry({ paneId: 1, leafId: 'leaf-0' }))
    const panesSnapshot = [...scene.panes]
    scene.panes.length = 0

    scene.outside.focus()
    scene.handler()

    expect(scene.onDropped).not.toHaveBeenCalled()
    expect(scene.queue.isPending()).toBe(true)

    // and it still lands once the manager reports the pane again
    scene.panes.push(...panesSnapshot)
    ;(scene.panes[0]!.container.firstElementChild as HTMLElement).focus()
    scene.handler()
    expect(scene.ptyWrites).toEqual(['dictated paragraph'])
  })

  it('keeps a live pane pending so the destroy check cannot swallow a normal defer', () => {
    const scene = buildScene()
    scene.queue.defer(entry({ paneId: 1, leafId: 'leaf-0' }))

    scene.outside.focus()
    scene.handler()

    expect(scene.onDropped).not.toHaveBeenCalled()
    expect(scene.queue.isPending()).toBe(true)
  })
})
