// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalStructuralReplayCoordinator } from './terminal-structural-replay-coordinator'

function deferred() {
  let resolve = (): void => {}
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function createTerminal(displayed = true) {
  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  const rows = document.createElement('div')
  rows.className = 'xterm-rows'
  rows.textContent = 'Last coherent frame'
  screen.append(rows)
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, displayed ? 1240 : 0, displayed ? 944 : 0)
  )
  element.append(screen)
  document.body.append(element)
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, displayed ? 1240 : 0, displayed ? 944 : 0)
  )
  const listeners = new Set<() => void>()
  const paints: { cols: number; rows: number; opacity: string }[] = []
  const terminal = {
    element,
    cols: 155,
    rows: 59,
    buffer: { active: { type: 'normal', viewportY: 0, baseY: 0 } },
    onResize: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    resize: (cols: number, rows: number) => {
      terminal.cols = cols
      terminal.rows = rows
      for (const listener of listeners) {
        listener()
      }
    },
    _core: {
      refresh: vi.fn(() => {
        paints.push({ cols: terminal.cols, rows: terminal.rows, opacity: screen.style.opacity })
      })
    }
  }
  return { terminal, screen, paints, listeners }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('structural replay presentation', () => {
  it('keeps the source grid offscreen until replay and the destination fit finish', async () => {
    const { terminal, screen, paints, listeners } = createTerminal()
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    const parsed = deferred()
    const fitting = deferred()
    const fitted = deferred()
    const started = deferred()
    const completion = coordinator.run(
      async () => {
        terminal.resize(120, 40)
        started.resolve()
        await parsed.promise
      },
      {
        afterRestore: async () => {
          fitting.resolve()
          await fitted.promise
          terminal.resize(155, 59)
        }
      }
    )
    await started.promise
    expect(screen.style.opacity).toBe('0')
    parsed.resolve()
    await fitting.promise
    expect(screen.style.opacity).toBe('0')
    expect(paints).toEqual([])
    fitted.resolve()
    await completion

    expect(paints).toEqual([{ cols: 155, rows: 59, opacity: '0' }])
    expect(terminal._core.refresh).toHaveBeenCalledWith(0, 58, true)
    expect(screen.style.opacity).toBe('')
    expect(listeners.size).toBe(0)
  })

  it('withholds a fresh terminal already at the source grid until its first fit', async () => {
    const { terminal, screen, paints } = createTerminal()
    terminal.resize(120, 40)
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    await coordinator.run(
      async () => {
        expect(screen.style.opacity).toBe('0')
        await Promise.resolve()
        expect(screen.style.opacity).toBe('0')
      },
      { afterRestore: () => terminal.resize(155, 59) }
    )
    expect(paints).toEqual([{ cols: 155, rows: 59, opacity: '0' }])
    expect(screen.style.opacity).toBe('')
  })

  it('retains a same-grid frame across a clear even without a pending fit', async () => {
    const { terminal, screen, paints } = createTerminal()
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    await coordinator.run(() => {
      expect(screen.style.opacity).toBe('0')
      screen.querySelector('.xterm-rows')?.replaceChildren()
      const retained = terminal.element.querySelector('[data-terminal-replay-frame]')
      expect(retained?.textContent).toBe('Last coherent frame')
      expect(retained?.getAttribute('aria-hidden')).toBe('true')
      expect(retained?.querySelector('textarea')).toBeNull()
    })
    expect(paints).toEqual([{ cols: 155, rows: 59, opacity: '0' }])
    expect(screen.style.opacity).toBe('')
    expect(terminal.element.querySelector('[data-terminal-replay-frame]')).toBeNull()
  })

  it('restores an existing opacity override after a failed fit', async () => {
    const { terminal, screen, listeners } = createTerminal()
    screen.style.setProperty('opacity', '0.4', 'important')
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    await expect(
      coordinator.run(() => terminal.resize(120, 40), {
        afterRestore: () => {
          throw new Error('fit failed')
        }
      })
    ).rejects.toThrow('fit failed')
    expect(screen.style.opacity).toBe('0.4')
    expect(screen.style.getPropertyPriority('opacity')).toBe('important')
    expect(listeners.size).toBe(0)
  })

  it('releases a cancelled replay without presenting the half-parsed source grid', async () => {
    const { terminal, screen, paints, listeners } = createTerminal()
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    const started = deferred()
    const completion = coordinator.run(async () => {
      terminal.resize(120, 40)
      started.resolve()
      await new Promise<void>(() => {})
    })
    await started.promise
    expect(screen.style.opacity).toBe('0')
    coordinator.dispose()
    await completion
    expect(screen.style.opacity).toBe('')
    expect(paints).toEqual([])
    expect(listeners.size).toBe(0)
  })

  it('does not unpause or force a hidden pane to paint', async () => {
    const { terminal, screen, paints } = createTerminal(false)
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    await coordinator.run(() => terminal.resize(120, 40))
    expect(screen.style.opacity).toBe('')
    expect(paints).toEqual([])
  })

  it('keeps the input focusable while its source-grid image is withheld', async () => {
    const { terminal, screen } = createTerminal()
    const textarea = document.createElement('textarea')
    screen.append(textarea)
    textarea.focus()
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    await coordinator.run(() => {
      terminal.resize(120, 40)
      expect(screen.style.opacity).toBe('0')
      expect(getComputedStyle(textarea).visibility).not.toBe('hidden')
      expect(document.activeElement).toBe(textarea)
    })
    expect(document.activeElement).toBe(textarea)
  })

  it('releases presentation when the bounded fit degrades without resizing', async () => {
    const { terminal, screen, listeners } = createTerminal()
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    await coordinator.run(() => terminal.resize(120, 40), {
      afterRestore: async () => {
        await Promise.resolve(false)
      }
    })
    expect(screen.style.opacity).toBe('')
    expect(listeners.size).toBe(0)
  })

  it('does not retain a superseded replay gate across the next transaction', async () => {
    const { terminal, screen, paints, listeners } = createTerminal()
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    await coordinator.run(() => terminal.resize(120, 40), { shouldRestore: () => false })
    expect(screen.style.opacity).toBe('')
    expect(paints).toEqual([])
    await coordinator.run(() => terminal.resize(155, 59))
    expect(paints).toEqual([{ cols: 155, rows: 59, opacity: '0' }])
    expect(screen.style.opacity).toBe('')
    expect(listeners.size).toBe(0)
  })

  it('removes retained frames on failed fits and disposal without duplicating input', async () => {
    const { terminal, screen } = createTerminal()
    const helpers = document.createElement('div')
    helpers.className = 'xterm-helpers'
    helpers.append(document.createElement('textarea'))
    screen.append(helpers)
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    await expect(
      coordinator.run(() => {
        expect(terminal.element.querySelectorAll('textarea')).toHaveLength(1)
        expect(terminal.element.querySelectorAll('.xterm-screen')).toHaveLength(1)
        throw new Error('parse failed')
      })
    ).rejects.toThrow('parse failed')
    expect(terminal.element.querySelector('[data-terminal-replay-frame]')).toBeNull()
    const started = deferred()
    const completion = coordinator.run(async () => {
      started.resolve()
      await new Promise<void>(() => {})
    })
    await started.promise
    expect(terminal.element.querySelector('[data-terminal-replay-frame]')).not.toBeNull()
    coordinator.dispose()
    await completion
    expect(terminal.element.querySelector('[data-terminal-replay-frame]')).toBeNull()
  })

  it('keeps a replacement session covered when the old session releases late', async () => {
    const { terminal, screen } = createTerminal()
    const oldSession = createTerminalStructuralReplayCoordinator(terminal)
    const nextSession = createTerminalStructuralReplayCoordinator(terminal)
    const oldStarted = deferred()
    const nextStarted = deferred()
    const parsed = deferred()
    const oldReplay = oldSession.run(async () => {
      oldStarted.resolve()
      await new Promise<void>(() => {})
    })
    await oldStarted.promise
    const nextReplay = nextSession.run(async () => {
      nextStarted.resolve()
      await parsed.promise
    })
    await nextStarted.promise
    expect(terminal.element.querySelectorAll('[data-terminal-replay-frame]')).toHaveLength(1)
    oldSession.dispose()
    await oldReplay
    expect(screen.style.opacity).toBe('0')
    expect(terminal.element.querySelectorAll('[data-terminal-replay-frame]')).toHaveLength(1)
    parsed.resolve()
    await nextReplay
    expect(screen.style.opacity).toBe('')
    expect(terminal.element.querySelector('[data-terminal-replay-frame]')).toBeNull()
  })

  it('captures geometry and renderer children after a parked resize is flushed', async () => {
    const { terminal, screen } = createTerminal()
    const canvas = document.createElement('canvas')
    screen.append(canvas)
    terminal._core.refresh.mockImplementationOnce(() => {
      canvas.remove()
      vi.mocked(screen.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 1400, 800))
    })
    await createTerminalStructuralReplayCoordinator(terminal).run(() => {
      const frame = terminal.element.querySelector<HTMLElement>('[data-terminal-replay-frame]')
      expect(frame?.style.width).toBe('1400px')
      expect(frame?.style.height).toBe('800px')
      expect(frame?.textContent).toBe('Last coherent frame')
    })
  })

  it('still replays and cleans up when a canvas cannot be copied', async () => {
    const { terminal, screen } = createTerminal()
    screen.append(document.createElement('canvas'))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('context lost')
    })
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    await coordinator.run(() => {
      expect(screen.style.opacity).toBe('0')
      expect(terminal.element.querySelector('[data-terminal-replay-frame]')).toBeNull()
    })
    expect(screen.style.opacity).toBe('')
  })

  it('does not force a synchronized-output frame open while capturing the old image', async () => {
    const { terminal, screen } = createTerminal()
    screen.append(document.createElement('canvas'))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const renderRows = vi.fn()
    const refreshRows = vi.fn()
    const synchronized = {
      ...terminal,
      _core: {
        ...terminal._core,
        coreService: { decPrivateModes: { synchronizedOutput: true } },
        _renderService: {
          _isPaused: false,
          refreshRows,
          _renderer: { value: { renderRows } }
        }
      }
    }
    await createTerminalStructuralReplayCoordinator(synchronized).run(() => {
      expect(refreshRows).toHaveBeenCalledWith(0, 58, true)
      expect(renderRows).not.toHaveBeenCalled()
      expect(terminal._core.refresh).not.toHaveBeenCalled()
    })
    expect(renderRows).toHaveBeenCalledTimes(1)
  })

  it('releases the screen even if a disposed renderer rejects the final present', async () => {
    const { terminal, screen, listeners } = createTerminal()
    terminal._core.refresh.mockImplementation(() => {
      throw new Error('renderer disposed')
    })
    const coordinator = createTerminalStructuralReplayCoordinator(terminal)
    await coordinator.run(() => terminal.resize(120, 40))
    expect(screen.style.opacity).toBe('')
    expect(listeners.size).toBe(0)
  })
})
