import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSshBackgroundStartupDelivery } from './ssh-background-startup-delivery'

const SHELL_READY = '\x1b]777;orca-shell-ready\x07'

function createDelivery(): {
  delivery: ReturnType<typeof createSshBackgroundStartupDelivery>
  write: ReturnType<typeof vi.fn>
} {
  const write = vi.fn()
  return {
    delivery: createSshBackgroundStartupDelivery({
      command: 'codex "run the automation"',
      waitForShellReady: true,
      write
    }),
    write
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createSshBackgroundStartupDelivery shell-ready fallback', () => {
  it('does not force delivery at the short deadline while the remote shell is still silent', () => {
    const { delivery, write } = createDelivery()

    // Armed at spawn, before any byte arrives (launch-agent-background-session).
    delivery.armFallback('pty-1')
    // A cold host sourcing /etc/profile plus nvm/pyenv has not prompted yet.
    vi.advanceTimersByTime(3_000)

    expect(write).not.toHaveBeenCalled()

    // The prompt finally lands with the marker; delivery follows normally.
    delivery.handleData(`${SHELL_READY}user@remote repo % `)
    vi.advanceTimersByTime(50)

    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[1]).toContain('codex "run the automation"')
  })

  it('still delivers eventually when a shell can never emit the marker, and not before 15s', () => {
    const { delivery, write } = createDelivery()

    delivery.armFallback('pty-1')
    // Pin the boundary: asserting only eventual delivery would let the budget
    // silently shrink back toward the short deadline this fix moved off.
    vi.advanceTimersByTime(14_999)

    expect(write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(50)

    expect(write).toHaveBeenCalledTimes(1)
  })

  it('keeps the short post-output deadline once the shell has started talking', () => {
    const { delivery, write } = createDelivery()

    delivery.armFallback('pty-1')
    // Output without the marker: the shell is alive but cannot emit it.
    delivery.handleData('user@remote repo % ')
    vi.advanceTimersByTime(1_550)
    vi.advanceTimersByTime(50)

    expect(write).toHaveBeenCalledTimes(1)
  })

  // The long budget exists to protect the bracketed paste from landing before
  // readline arms it. 'fast' delivery waits for no marker and pastes nothing
  // prompt-sensitive, so stretching it there is latency with nothing bought.
  it('keeps the short deadline for fast delivery, which waits for no marker', () => {
    const write = vi.fn()
    const delivery = createSshBackgroundStartupDelivery({
      command: 'codex "run the automation"',
      waitForShellReady: false,
      write
    })

    delivery.armFallback('pty-1')
    vi.advanceTimersByTime(1_550)

    expect(write).toHaveBeenCalledTimes(1)
  })
})
