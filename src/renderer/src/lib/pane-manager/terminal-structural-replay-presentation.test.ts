// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalStructuralReplayCoordinator } from './terminal-structural-replay-coordinator'
import { TERMINAL_REPLAY_PRESENTATION_MAX_HOLD_MS } from './terminal-replay-presentation'

function deferred() {
  let resolve = (): void => {}
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function createTerminal() {
  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  const rows = document.createElement('div')
  rows.className = 'xterm-rows'
  rows.textContent = 'Last coherent frame'
  screen.append(rows)
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1240, 944))
  element.append(screen)
  document.body.append(element)
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1240, 944))
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
        paints.push({
          cols: terminal.cols,
          rows: terminal.rows,
          opacity: screen.style.opacity
        })
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

  it('does not let a replay released after the cap reveal a newer hold', async () => {
    vi.useFakeTimers()
    try {
      const { terminal, screen } = createTerminal()
      const stuck = createTerminalStructuralReplayCoordinator(terminal)
      const later = createTerminalStructuralReplayCoordinator(terminal)
      const release = deferred()
      const stuckReplay = stuck.run(() => release.promise)
      await vi.advanceTimersByTimeAsync(TERMINAL_REPLAY_PRESENTATION_MAX_HOLD_MS)
      expect(screen.style.opacity).toBe('')
      const parsed = deferred()
      const laterReplay = later.run(() => parsed.promise)
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.style.opacity).toBe('0')
      release.resolve()
      await stuckReplay
      expect(screen.style.opacity).toBe('0')
      expect(terminal.element.querySelectorAll('[data-terminal-replay-frame]')).toHaveLength(1)
      parsed.resolve()
      await laterReplay
      expect(screen.style.opacity).toBe('')
      expect(terminal.element.querySelector('[data-terminal-replay-frame]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
