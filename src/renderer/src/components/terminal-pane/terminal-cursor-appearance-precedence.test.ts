// @vitest-environment happy-dom
/** Verify settings round-trip and DECSCUSR precedence (#12729); IME overlay is separate. DOM rendering only: WebGL drops cursor alpha for block cursors, so theme composition alone cannot prove visible opacity. */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeTerminalCursorStyleDefault } from '../../../../shared/terminal-cursor-style-settings'
import { composeActiveTerminalTheme } from './terminal-appearance'

function decPrivateCursorStyle(terminal: Terminal): string | undefined {
  return (
    terminal as unknown as {
      _core: { coreService: { decPrivateModes: { cursorStyle?: string } } }
    }
  )._core.coreService.decPrivateModes.cursorStyle
}

function cursorClasses(container: HTMLElement): string[] {
  const cursor = container.querySelector('.xterm-rows .xterm-cursor')
  if (!cursor) {
    throw new Error('no cursor cell was rendered')
  }
  return [...cursor.classList]
}

/** Resolves once the emulator has parsed `data`, so the escape has taken effect before any read. */
function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

// Drain pending frames and subscribe before refresh so the awaited render follows the action.
async function actAndAwaitRender(
  terminal: Terminal,
  act: () => void | Promise<void>
): Promise<void> {
  await act()
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  const rendered = new Promise<void>((resolve) => {
    const listener = terminal.onRender(() => {
      listener.dispose()
      resolve()
    })
  })
  terminal.refresh(0, terminal.rows - 1)
  await rendered
}

describe('#12729 — cursor style and opacity survive the settings path', () => {
  it('keeps an explicitly chosen bar across the settings write and the next load', () => {
    const written = normalizeTerminalCursorStyleDefault(
      { terminalCursorStyle: 'bar' },
      { preserveExplicitValue: true }
    )
    expect(written).toEqual({
      terminalCursorStyle: 'bar',
      terminalCursorStyleDefaultedToBlock: true
    })

    expect(normalizeTerminalCursorStyleDefault(written).terminalCursorStyle).toBe('bar')
  })

  it('composes terminalCursorOpacity into the theme cursor colour', () => {
    const theme = composeActiveTerminalTheme(
      { background: '#112233', foreground: '#aabbcc', cursor: '#ffffff' },
      { terminalCursorOpacity: 0.1 }
    )

    expect(theme?.cursor).toBe('rgba(255, 255, 255, 0.1)')
  })
})

describe('#12729 — DECSCUSR from the program outranks the preference', () => {
  const openTerminals: Terminal[] = []

  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('pins the shape a prompt asked for until CSI 0 SP q hands it back', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const terminal = new Terminal({ cols: 40, rows: 6, cursorStyle: 'bar' })
    terminal.open(container)
    openTerminals.push(terminal)
    terminal.focus()

    await actAndAwaitRender(terminal, () => write(terminal, 'x'))
    expect(decPrivateCursorStyle(terminal)).toBeUndefined()
    expect(cursorClasses(container)).toContain('xterm-cursor-bar')

    // `CSI 2 SP q` — steady block, what a prompt framework emits on every redraw.
    await actAndAwaitRender(terminal, () => write(terminal, '\x1b[2 q'))
    expect(decPrivateCursorStyle(terminal)).toBe('block')
    // Assert the rendered class; preference and active escape-mode fields are distinct.
    expect(cursorClasses(container)).toContain('xterm-cursor-block')
    expect(cursorClasses(container)).not.toContain('xterm-cursor-bar')

    // Changing the preference while that is set cannot win it back; only the reset does.
    await actAndAwaitRender(terminal, () => {
      terminal.options.cursorStyle = 'underline'
    })
    expect(cursorClasses(container)).toContain('xterm-cursor-block')

    // Orca sends this reset on replay and on the agent-idle path (RESET_TERMINAL_CURSOR_STYLE).
    await actAndAwaitRender(terminal, () => write(terminal, '\x1b[0 q'))
    expect(decPrivateCursorStyle(terminal)).toBeUndefined()
    expect(cursorClasses(container)).toContain('xterm-cursor-underline')
  })
})
