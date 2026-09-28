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

// Bracketed paste only wraps multiline submissions, so the marker's effect on it
// is only observable through a command that carries a newline.
const MULTILINE_COMMAND = 'codex "run the\nautomation"'

function createMultilineDelivery(waitForShellReady: boolean): {
  delivery: ReturnType<typeof createSshBackgroundStartupDelivery>
  write: ReturnType<typeof vi.fn>
} {
  const write = vi.fn()
  return {
    delivery: createSshBackgroundStartupDelivery({
      command: MULTILINE_COMMAND,
      waitForShellReady,
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

  // #18767: the marker is what proves the host wrapped the shell and armed
  // bracketed paste. A fallback release means it never did.
  it('uses bracketed paste only after the marker actually arrived', () => {
    const { delivery, write } = createMultilineDelivery(true)

    delivery.armFallback('pty-1')
    delivery.handleData(`${SHELL_READY}user@remote repo % `)
    vi.advanceTimersByTime(50)

    expect(write.mock.calls[0]?.[1]).toContain('\x1b[200~')
  })

  // The host answers in the spawn reply whether it armed the marker. `false` means
  // none will ever come, so the pre-#18796 fast path applies; `true` keeps the wait;
  // absent is an older host and leaves the client-side prediction alone.
  describe('host shell-ready verdict', () => {
    it('delivers immediately and raw when the host reports the marker was not armed', () => {
      const { delivery, write } = createMultilineDelivery(true)

      delivery.applyHostShellReadyArmed(false)
      delivery.armFallback('pty-1')
      // The launch flow schedules on every data chunk (launch-agent-background-session).
      delivery.handleData('user@remote repo % ')
      delivery.schedule('pty-1')
      vi.advanceTimersByTime(50)

      expect(write).toHaveBeenCalledTimes(1)
      expect(write.mock.calls[0]?.[1]).not.toContain('\x1b[200~')
    })

    it('keeps the short silent-shell budget once the host says no marker is coming', () => {
      const { delivery, write } = createDelivery()

      delivery.applyHostShellReadyArmed(false)
      delivery.armFallback('pty-1')
      vi.advanceTimersByTime(1_550)

      expect(write).toHaveBeenCalledTimes(1)
    })

    it('still waits for the marker when the host reports it armed one', () => {
      const { delivery, write } = createDelivery()

      delivery.applyHostShellReadyArmed(true)
      delivery.armFallback('pty-1')
      delivery.handleData('user@remote repo % ')
      vi.advanceTimersByTime(1_400)

      expect(write).not.toHaveBeenCalled()

      delivery.handleData(`${SHELL_READY}user@remote repo % `)
      vi.advanceTimersByTime(50)

      expect(write).toHaveBeenCalledTimes(1)
    })

    it('keeps the client-side prediction when an older host omits the verdict', () => {
      const { delivery, write } = createDelivery()

      delivery.applyHostShellReadyArmed(undefined)
      delivery.armFallback('pty-1')
      delivery.handleData('user@remote repo % ')
      vi.advanceTimersByTime(1_400)

      expect(write).not.toHaveBeenCalled()

      vi.advanceTimersByTime(150)
      vi.advanceTimersByTime(50)

      expect(write).toHaveBeenCalledTimes(1)
    })
  })

  it('submits raw when the wait ends at the fallback instead of the marker', () => {
    const { delivery, write } = createMultilineDelivery(true)

    delivery.armFallback('pty-1')
    delivery.handleData('user@remote repo % ')
    vi.advanceTimersByTime(1_550)
    vi.advanceTimersByTime(50)

    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[1]).not.toContain('\x1b[200~')
  })
})
