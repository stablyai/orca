import { describe, expect, it, vi } from 'vitest'
import {
  forceFullViewportPresent,
  forceRepaintThroughRenderPause,
  requestFullViewportPresent
} from './terminal-render-pause-release'

// Why a separate file: the parked-resize contract is one hazard shared by all
// three helpers, and the main spec is already at the max-lines budget.

type FakeRenderService = {
  _isPaused: boolean
  _needsFullRefresh: boolean
  _pausedResizeTask?: { flush: ReturnType<typeof vi.fn> } | null
  refreshRows: ReturnType<typeof vi.fn>
  _renderer?: { value?: { renderRows?: ReturnType<typeof vi.fn> } }
}

function createPausedTerminal(options: {
  synchronizedOutput?: boolean
  withoutTask?: boolean
  flushThrows?: boolean
}): { terminal: unknown; service: FakeRenderService; order: string[] } {
  const order: string[] = []
  const flush = vi.fn(() => {
    order.push('flush')
    if (options.flushThrows) {
      throw new Error('renderer disposed')
    }
  })
  const service: FakeRenderService = {
    _isPaused: true,
    _needsFullRefresh: true,
    _pausedResizeTask: options.withoutTask ? null : { flush },
    refreshRows: vi.fn(() => order.push('refreshRows')),
    _renderer: { value: { renderRows: vi.fn(() => order.push('renderRows')) } }
  }
  const terminal = {
    rows: 24,
    _core: {
      _renderService: service,
      coreService: { decPrivateModes: { synchronizedOutput: options.synchronizedOutput === true } }
    }
  }
  return { terminal, service, order }
}

const helpers = [
  ['forceRepaintThroughRenderPause', forceRepaintThroughRenderPause],
  ['requestFullViewportPresent', requestFullViewportPresent],
  ['forceFullViewportPresent', forceFullViewportPresent]
] as const

describe.each(helpers)('%s parked renderer resize', (_name, present) => {
  it('flushes the resize xterm parked while paused before presenting', () => {
    // A resize that lands under _isPaused only parks WebglRenderer.handleResize;
    // xterm flushes it solely from the observer callback we are pre-empting.
    const { terminal, service, order } = createPausedTerminal({})

    expect(present(terminal)).toBe(true)
    expect(service._pausedResizeTask?.flush).toHaveBeenCalledTimes(1)
    expect(order[0]).toBe('flush')
    expect(order).toHaveLength(2)
    expect(service._isPaused).toBe(false)
    expect(service._needsFullRefresh).toBe(false)
  })

  it('flushes before a DEC 2026 present too', () => {
    const { terminal, service, order } = createPausedTerminal({ synchronizedOutput: true })

    expect(present(terminal)).toBe(true)
    expect(service._pausedResizeTask?.flush).toHaveBeenCalledTimes(1)
    expect(order[0]).toBe('flush')
  })

  it('still presents when the parked-task internal is unavailable', () => {
    const { terminal, service } = createPausedTerminal({ withoutTask: true })

    expect(present(terminal)).toBe(true)
    expect(service._isPaused).toBe(false)
  })

  it('still presents when the parked resize throws', () => {
    const { terminal, order } = createPausedTerminal({ flushThrows: true })

    expect(present(terminal)).toBe(true)
    expect(order).toEqual(['flush', expect.any(String)])
  })
})

describe('parked renderer resize on an unpaused terminal', () => {
  it('is left to xterm when the pause latch is not set', () => {
    const flush = vi.fn()
    const service = {
      _isPaused: false,
      _needsFullRefresh: false,
      _pausedResizeTask: { flush },
      refreshRows: vi.fn()
    }
    const terminal = {
      rows: 24,
      _core: {
        _renderService: service,
        coreService: { decPrivateModes: { synchronizedOutput: true } }
      }
    }

    expect(requestFullViewportPresent(terminal)).toBe(true)
    expect(forceFullViewportPresent(terminal)).toBe(true)
    expect(forceRepaintThroughRenderPause(terminal)).toBe(false)
    expect(flush).not.toHaveBeenCalled()
  })
})
