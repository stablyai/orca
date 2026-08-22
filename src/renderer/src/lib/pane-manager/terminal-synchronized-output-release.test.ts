import { describe, expect, it, vi } from 'vitest'
import { releaseAbandonedSynchronizedOutput } from './terminal-synchronized-output-release'

function createTerminal(options: {
  synchronizedOutput?: boolean | undefined
  withoutCore?: boolean
  withoutModes?: boolean
  flush?: () => unknown
}): unknown {
  if (options.withoutCore) {
    return {}
  }
  return {
    _core: {
      coreService: options.withoutModes
        ? {}
        : { decPrivateModes: { synchronizedOutput: options.synchronizedOutput } },
      _renderService: { _syncOutputHandler: { flush: options.flush } }
    }
  }
}

describe('releaseAbandonedSynchronizedOutput', () => {
  it('clears a latched synchronized-output frame and flushes its buffered rows', () => {
    const flush = vi.fn()
    const terminal = createTerminal({ synchronizedOutput: true, flush })

    expect(releaseAbandonedSynchronizedOutput(terminal)).toBe(true)
    expect(
      (terminal as { _core: { coreService: { decPrivateModes: { synchronizedOutput: boolean } } } })
        ._core.coreService.decPrivateModes.synchronizedOutput
    ).toBe(false)
    // The buffered range dies with the latch; the caller's own full refresh
    // repaints those rows, and leaving it armed keeps xterm's 1s timer alive.
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('leaves an unlatched terminal untouched', () => {
    const flush = vi.fn()
    expect(
      releaseAbandonedSynchronizedOutput(createTerminal({ synchronizedOutput: false, flush }))
    ).toBe(false)
    expect(
      releaseAbandonedSynchronizedOutput(createTerminal({ synchronizedOutput: undefined, flush }))
    ).toBe(false)
    expect(flush).not.toHaveBeenCalled()
  })

  it('degrades to a no-op when xterm internals are unavailable', () => {
    expect(releaseAbandonedSynchronizedOutput(createTerminal({ withoutCore: true }))).toBe(false)
    expect(releaseAbandonedSynchronizedOutput(createTerminal({ withoutModes: true }))).toBe(false)
    expect(releaseAbandonedSynchronizedOutput(null)).toBe(false)
    expect(releaseAbandonedSynchronizedOutput(undefined)).toBe(false)
  })

  it('still clears the latch when the buffered-row flush throws', () => {
    const terminal = createTerminal({
      synchronizedOutput: true,
      flush: () => {
        throw new Error('disposed mid-frame')
      }
    })

    expect(releaseAbandonedSynchronizedOutput(terminal)).toBe(true)
    expect(
      (terminal as { _core: { coreService: { decPrivateModes: { synchronizedOutput: boolean } } } })
        ._core.coreService.decPrivateModes.synchronizedOutput
    ).toBe(false)
  })

  it('unblocks the repaint that xterm would otherwise swallow', () => {
    // Mirrors RenderService.refreshRows' gate order: the synchronizedOutput
    // check precedes rendering, so a latched frame turns every reveal repaint
    // into a no-op — the STA-2694 failure.
    const modes = { synchronizedOutput: true }
    let rendered = 0
    const refreshRows = (): void => {
      if (modes.synchronizedOutput) {
        return
      }
      rendered += 1
    }
    const terminal = {
      _core: { coreService: { decPrivateModes: modes }, _renderService: {} }
    }

    refreshRows()
    expect(rendered, 'a latched frame swallows the repaint').toBe(0)

    releaseAbandonedSynchronizedOutput(terminal)
    refreshRows()
    expect(rendered, 'releasing the latch lets the repaint through').toBe(1)
  })
})
