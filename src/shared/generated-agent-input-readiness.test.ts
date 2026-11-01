import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForGeneratedAgentInput } from './generated-agent-input-readiness'

const MARKER = '\x1b[?2004h\x1b[?2031h❯\u00a0'

afterEach(() => vi.useRealTimers())

function fixture(timeoutMs = 5000) {
  vi.useFakeTimers()
  let observe = (_data: string): void => {}
  let clear = false
  const accept = vi.fn(async () => clear)
  const dispose = vi.fn()
  const result = waitForGeneratedAgentInput(
    {
      subscribe: (listener) => {
        observe = listener
        return dispose
      },
      accept
    },
    'claude-composer-prompt',
    { timeoutMs }
  )
  return {
    result,
    accept,
    dispose,
    emit: (data: string) => observe(data),
    clear: () => {
      clear = true
    }
  }
}

describe('generated input admission', () => {
  it('waits through a dialog despite paste mode and quiet; deadline never authorizes input', async () => {
    const f = fixture()
    const write = vi.fn()
    const delivery = f.result.then((ready) => {
      if (ready) {
        write()
      }
    })
    f.emit('\x1b[?2004hEnter to confirm · Esc to cancel')
    await vi.advanceTimersByTimeAsync(5000)
    await delivery
    expect(write).not.toHaveBeenCalled()
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('delivers once after the user dismisses the dialog and the composer appears', async () => {
    const f = fixture()
    f.emit('\x1b[?2004hEnter to confirm · Esc to cancel')
    await vi.advanceTimersByTimeAsync(2000)
    f.clear()
    f.emit(MARKER)
    await vi.advanceTimersByTimeAsync(150)
    await expect(f.result).resolves.toBe(true)
  })

  it('measures compatibility quiet live from subscription without requiring a lost startup byte', async () => {
    vi.useFakeTimers()
    const result = waitForGeneratedAgentInput(
      { subscribe: () => () => {}, accept: async () => true },
      'render-quiet-after-bracketed-paste'
    )
    let settled = false
    void result.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1499)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(151)
    await expect(result).resolves.toBe(true)
  })

  it('fences an asynchronous acceptance read that finishes after the deadline', async () => {
    const f = fixture(1000)
    let answer: (ready: boolean) => void = () => {}
    f.accept.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    f.emit(MARKER)
    await vi.advanceTimersByTimeAsync(150)
    await vi.advanceTimersByTimeAsync(1000)
    answer(true)
    await expect(f.result).resolves.toBe(false)
  })

  it('revokes a marker across a split shell handoff and requires a fresh signal', async () => {
    const f = fixture(1000)
    f.emit(MARKER)
    await vi.advanceTimersByTimeAsync(150)
    f.emit('\x1b[?200')
    f.emit('4l')
    f.clear()
    await vi.advanceTimersByTimeAsync(1000)
    await expect(f.result).resolves.toBe(false)
  })

  it('never turns an incomplete structural grace into success at the deadline', async () => {
    vi.useFakeTimers()
    const result = waitForGeneratedAgentInput(
      {
        subscribe: () => () => {},
        replay: () => '\x1b[?1049h\x1b[?2004h\x1b[24;24H┃\x1b[25;24H╹\x1b[22;27H\x1b[?25h',
        accept: () => true
      },
      'opencode-agent-row',
      { timeoutMs: 1000 }
    )
    await vi.advanceTimersByTimeAsync(1000)
    await expect(result).resolves.toBe(false)
  })
})
