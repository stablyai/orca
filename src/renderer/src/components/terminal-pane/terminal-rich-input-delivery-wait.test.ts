import { describe, expect, it, vi } from 'vitest'
import { waitForRichInputPasteDelivery } from './terminal-rich-input-delivery-wait'

/** Virtual clock: `delay` advances time instead of sleeping, so waits are deterministic. */
function createClock() {
  let current = 0
  const listeners: (() => void)[] = []
  const writesAt = new Map<number, number>()
  return {
    now: () => current,
    delay: async (milliseconds: number): Promise<void> => {
      const target = current + milliseconds
      for (const [at, count] of [...writesAt].sort((a, b) => a[0] - b[0])) {
        if (at > current && at <= target) {
          current = at
          for (let index = 0; index < count; index++) {
            listeners.forEach((listener) => listener())
          }
        }
      }
      current = target
    },
    /** Schedule a parsed-write notification at an absolute time. */
    writeAt: (at: number, count = 1) => writesAt.set(at, count),
    terminal: {
      onWriteParsed: (listener: () => void) => {
        listeners.push(listener)
        return {
          dispose: () => {
            const index = listeners.indexOf(listener)
            if (index !== -1) {
              listeners.splice(index, 1)
            }
          }
        }
      }
    }
  }
}

describe('rich input paste delivery wait', () => {
  it('falls back to the fixed delay when the xterm build has no parse signal', async () => {
    const delay = vi.fn(async () => {})
    const result = await waitForRichInputPasteDelivery({
      terminal: {},
      fallbackDelayMs: 500,
      delay
    })
    expect(delay).toHaveBeenCalledExactlyOnceWith(500)
    expect(result.confirmed).toBe(false)
  })

  it('returns well before the old fixed delay when the agent redraws locally', async () => {
    const clock = createClock()
    clock.writeAt(20)
    const result = await waitForRichInputPasteDelivery({
      terminal: clock.terminal,
      fallbackDelayMs: 500,
      delay: clock.delay,
      now: clock.now
    })
    expect(result.confirmed).toBe(true)
    // Why this is the local win: the old path always paid 500ms.
    expect(clock.now()).toBeLessThan(500)
    expect(clock.now()).toBeGreaterThanOrEqual(80)
  })

  it('keeps waiting past the old fixed delay when the redraw is slow to arrive', async () => {
    const clock = createClock()
    clock.writeAt(900)
    const result = await waitForRichInputPasteDelivery({
      terminal: clock.terminal,
      fallbackDelayMs: 500,
      delay: clock.delay,
      now: clock.now
    })
    // Why this is the regression: the old path sent Enter at 500ms, before the agent had
    // the prompt, and still reported success.
    expect(result.confirmed).toBe(true)
    expect(clock.now()).toBeGreaterThan(900)
  })

  it('reports an unconfirmed delivery instead of claiming success when no redraw arrives', async () => {
    const clock = createClock()
    const result = await waitForRichInputPasteDelivery({
      terminal: clock.terminal,
      fallbackDelayMs: 500,
      delay: clock.delay,
      now: clock.now
    })
    expect(result.confirmed).toBe(false)
    expect(clock.now()).toBeGreaterThanOrEqual(2_000)
  })

  it('bounds a redraw that keeps producing output', async () => {
    const clock = createClock()
    for (let at = 20; at <= 2_000; at += 20) {
      clock.writeAt(at)
    }
    const result = await waitForRichInputPasteDelivery({
      terminal: clock.terminal,
      fallbackDelayMs: 500,
      delay: clock.delay,
      now: clock.now
    })
    expect(result.confirmed).toBe(true)
    // Settle cap keeps a chatty redraw from holding the submit open indefinitely.
    expect(clock.now()).toBeLessThanOrEqual(20 + 250 + 20)
  })

  it('unsubscribes from the terminal on every exit path', async () => {
    const dispose = vi.fn()
    const terminal = { onWriteParsed: () => ({ dispose }) }
    await waitForRichInputPasteDelivery({
      terminal,
      fallbackDelayMs: 500,
      delay: async () => {},
      now: (() => {
        let value = 0
        return () => (value += 500)
      })()
    })
    expect(dispose).toHaveBeenCalledOnce()
  })
})
