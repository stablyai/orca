// @vitest-environment happy-dom
/**
 * Issue #12729's second claim — "`terminalCursorStyle` / `terminalCursorOpacity` are ignored".
 *
 * Neither reproduces as a plumbing defect: an explicit `bar` survives the settings round trip and
 * the opacity composes into the theme's cursor colour. What the report was looking at is the IME
 * preedit overlay, which no cursor option reaches by construction
 * (`terminal-ime-xterm-trailing-preedit-occlusion.test.ts`).
 *
 * The one thing that does override the preference is a `DECSCUSR` from the running program, which
 * every terminal honours and which prompt frameworks emit routinely. That precedence is pinned
 * here because it is the answer to "my setting does nothing" whenever the overlay is not involved.
 *
 * Note what this file does NOT establish: composing the opacity into `theme.cursor` is not the same
 * as it reaching the screen. The webgl renderer uses the cursor colour as a cell background and
 * drops its alpha, so opacity is inert for a block cursor there — the default style on the default
 * renderer. That is upstream in the addon, and only the DOM renderer is exercised below.
 */
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

/**
 * Lets the act settle, drains the frame it already scheduled, then subscribes before forcing the
 * one under assertion — so the awaited render is guaranteed to post-date the act, and the listener
 * is always in place before its trigger runs.
 */
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
    // The write path stamps the migration flag alongside the user's choice.
    const written = normalizeTerminalCursorStyleDefault(
      { terminalCursorStyle: 'bar' },
      { preserveExplicitValue: true }
    )
    expect(written).toEqual({
      terminalCursorStyle: 'bar',
      terminalCursorStyleDefaultedToBlock: true
    })

    // The load path re-runs the migration over what was persisted and must not re-default it.
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
    // The rendered class, not the private mode: the two are separate fields, so only what the
    // renderer resolved out of them can fail when the precedence itself is dropped.
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
    // And control lands back on the preference, which moved to underline while DECSCUSR held it.
    expect(cursorClasses(container)).toContain('xterm-cursor-underline')
  })
})
