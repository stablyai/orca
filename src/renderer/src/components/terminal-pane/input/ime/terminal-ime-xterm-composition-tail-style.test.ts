// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { contrastRatio, hexToRgb } from '../../../../../../shared/color/rgba-contrast'
import { createTerminalIosHangulPreeditRenderer } from './terminal-ios-hangul-preedit-overlay'

const THEME = { background: '#112233', foreground: '#aabbcc' }
const CELL_WIDTH = 10
// Fallback-font glyphs whose advance differs from the cell they occupy.
const GLYPH_ADVANCE: Record<string, number> = { '│': 6, 가: 17 }

let terminal: Terminal

beforeEach(() => {
  // xterm sizes cells and measures glyph advances through these canvases; happy-dom has no text metrics.
  const context = {
    measureText: (text: string) => ({
      width: Array.from(text).reduce((sum, glyph) => sum + (GLYPH_ADVANCE[glyph] ?? CELL_WIDTH), 0),
      fontBoundingBoxAscent: 14,
      fontBoundingBoxDescent: 4
    })
  }
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext(): typeof context {
        return context
      }
    }
  )
})

afterEach(() => {
  terminal.dispose()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function open(options: ConstructorParameters<typeof Terminal>[0]): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  terminal = new Terminal(options)
  terminal.open(container)
  return container.querySelector<HTMLElement>('.composition-view')!
}

function write(data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function updateComposition(text: string): void {
  const update = new CompositionEvent('compositionupdate')
  Object.defineProperty(update, 'data', { value: text })
  terminal.textarea!.dispatchEvent(update)
}

function compose(text: string): void {
  const textarea = terminal.textarea!
  textarea.dispatchEvent(new CompositionEvent('compositionstart'))
  textarea.value = text
  updateComposition(text)
}

/** The colour as the DOM serializes it, so assertions do not depend on CSS notation. */
function css(value: string): string {
  const probe = document.createElement('span')
  probe.style.color = value
  return probe.style.color
}

function contrast(a: string, b: string): number {
  return contrastRatio(hexToRgb(a), hexToRgb(b))
}

it('draws a mid-box row tail in its cells’ colours, each glyph spanning its cells', async () => {
  const view = open({ cols: 40, theme: THEME })
  // A TUI prompt box: grey padding, a dim hint, a wide glyph, a border, then the pane beside it.
  await write('\x1b[48;5;240m \x1b[2mhint\x1b[22m 가    │\x1b[0m pane\r\x1b[1C')

  compose('한')

  const remainder = view.querySelector('.xterm-composition-remainder')!
  const cells = Array.from(remainder.childNodes, (run) => {
    const style = run instanceof HTMLElement ? run.style : undefined
    return Array.from(run.textContent ?? '', (glyph) => ({
      glyph,
      advance:
        (GLYPH_ADVANCE[glyph] ?? CELL_WIDTH) + Number.parseFloat(style?.letterSpacing || '0'),
      background: style?.backgroundColor ?? '',
      color: style?.color ?? ''
    }))
  }).flat()
  // xterm's 256-colour palette entry 240.
  const box = css('#585858')

  // The view takes the box colour behind the preedit; only cells outside the box paint their own.
  expect(css(view.style.backgroundColor)).toBe(box)
  expect(cells.map((cell) => cell.glyph).join('')).toBe('hint 가    │ pane')
  expect(cells.map((cell) => cell.background && css(cell.background))).toEqual([
    ...Array(11).fill(''),
    ...Array(5).fill(css(THEME.background))
  ])
  expect(cells.slice(0, 4).map((cell) => css(cell.color))).toEqual(
    Array(4).fill(css(`${THEME.foreground}80`))
  )
  expect(cells.map((cell) => cell.advance)).toEqual([
    ...Array(5).fill(CELL_WIDTH),
    2 * CELL_WIDTH,
    ...Array(10).fill(CELL_WIDTH)
  ])
})

it.each([
  {
    name: 'an inverse caret cell a TUI paints at the cursor',
    theme: { background: '#000000', foreground: '#ffffff', cursor: '#ffffff' },
    row: '\u276F \x1b[7mT\x1b[27m\x1b[2mry it\x1b[22m\r\x1b[2C',
    background: '#000000'
  },
  {
    name: 'a dark TUI box under a light theme',
    theme: { background: '#ffffff', foreground: '#222222', cursor: '#222222' },
    row: '\x1b[48;2;30;30;30m  ab  \x1b[0m\r\x1b[1C',
    background: '#1e1e1e'
  },
  {
    name: 'a reverse-video input field',
    theme: { background: '#000000', foreground: '#ffffff', cursor: '#ffffff' },
    row: '\x1b[7mSearch: ab      \x1b[27m\r\x1b[8C',
    background: '#ffffff'
  },
  {
    name: 'the last cell of a reverse-video input field',
    theme: { background: '#000000', foreground: '#ffffff', cursor: '#ffffff' },
    row: '\x1b[7mSearch: ab\x1b[27m\r\x1b[9C',
    background: '#ffffff'
  }
])('keeps the preedit and caret readable on $name', async ({ theme, row, background }) => {
  const view = open({ cols: 40, theme })
  await write(row)

  compose('한')

  const caret = view.querySelector<HTMLElement>('.xterm-composition-caret')!
  const remainder = view.querySelector<HTMLElement>('.xterm-composition-remainder')!
  expect(css(view.style.backgroundColor)).toBe(css(background))
  expect(contrast(view.style.color, background)).toBeGreaterThanOrEqual(3)
  expect(contrast(caret.style.backgroundColor, background)).toBeGreaterThanOrEqual(3)
  // The tail's default-colour cells stay as the grid draws them, and a lone inverse caret is drawn
  // plain, so no tail cell paints a background of its own.
  expect(css(remainder.style.color)).toBe(css(theme.foreground))
  expect(remainder.innerHTML).not.toContain('background')
})

// A low-contrast theme with the minimum contrast left below the preedit's floor of 3.
const LOW_CONTRAST = {
  minimumContrastRatio: 1,
  theme: { background: '#333333', foreground: '#555555' }
}

it('keeps the preedit at the theme foreground on the theme background below a contrast of 3', async () => {
  const view = open({ cols: 40, ...LOW_CONTRAST })
  await write('ab\r')

  compose('한')

  expect(css(view.style.backgroundColor)).toBe(css('#333333'))
  expect(css(view.style.color)).toBe(css('#555555'))
})

it('still lifts the preedit to a contrast of 3 on a TUI box', async () => {
  const view = open({ cols: 40, ...LOW_CONTRAST })
  await write('\x1b[48;2;68;68;68m  ab  \x1b[0m\r\x1b[1C')

  compose('한')

  expect(css(view.style.backgroundColor)).toBe(css('#444444'))
  expect(contrast(view.style.color, '#444444')).toBeGreaterThanOrEqual(3)
})

it('draws tail text at the minimum contrast the grid lifts it to', async () => {
  const view = open({
    cols: 40,
    minimumContrastRatio: 4.5,
    theme: { background: '#ffffff', foreground: '#222222' }
  })
  // A dark box under a light theme: default and dim text, then a border the grid leaves unadjusted.
  await write('\x1b[48;2;30;30;30m  ab \x1b[2mcd\x1b[22;38;2;40;40;40m\u2502\x1b[0m\r\x1b[1C')

  compose('한')

  const runs = Array.from(
    view.querySelectorAll<HTMLElement>('.xterm-composition-remainder span'),
    (run) => [run.textContent, css(run.style.color)]
  )
  expect(runs).toEqual([
    [' ab ', css('#8b8b8b')],
    ['cd', css('#5f5f5f80')],
    ['\u2502', css('#282828')]
  ])
  expect(contrast(view.style.color, '#1e1e1e')).toBeGreaterThanOrEqual(4.5)
})

it('keeps every column of a tail with more style changes than the run cap', async () => {
  const view = open({ cols: 100, theme: THEME })
  await write(`${Array.from({ length: 80 }, (_, i) => `\x1b[38;5;${16 + i}mx`).join('')}\x1b[0m\r`)

  compose('한')

  expect(view.querySelector('.xterm-composition-remainder')!.textContent).toBe('x'.repeat(80))
})

it('redraws the tail when a TUI rewrites its cells under the composition', async () => {
  const view = open({ cols: 40, theme: THEME })
  await write('a\x1b[31mbc\x1b[0mde\r')
  compose('한')

  // Save the cursor, rewrite the last two cells in another colour, and restore it, as a TUI repaint would.
  await write('\x1b7\x1b[4G\x1b[32mDE\x1b[0m\x1b8')
  updateComposition('하')

  expect(view.querySelector('.xterm-composition-remainder')!.textContent).toBe('abcDE')
})

it('redraws the tail in the new foreground and weight when the theme or font weight changes', async () => {
  const view = open({ cols: 40, theme: THEME })
  await write('ab\r')
  compose('한')
  const remainder = view.querySelector<HTMLElement>('.xterm-composition-remainder')!

  terminal.options.theme = { ...THEME, foreground: '#ddeeff' }
  terminal.options.fontWeight = 'bold'

  expect(css(remainder.style.color)).toBe(css('#ddeeff'))
  expect(css(view.style.color)).toBe(css('#ddeeff'))
  expect(remainder.style.fontWeight).toBe('bold')
})

it('leaves the iPad Hangul overlay in its own colours when xterm renders on a TUI box', async () => {
  const view = open({ cols: 40, theme: THEME })
  await write('\x1b[48;5;240m  ab  \x1b[0m\r\x1b[1C')
  // The overlay places itself from the screen's bounds, which happy-dom does not lay out.
  const screen = terminal.element!.querySelector<HTMLElement>('.xterm-screen')!
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 432))
  createTerminalIosHangulPreeditRenderer(terminal)('한')

  await new Promise<void>((resolve) => {
    const rendered = terminal.onRender(() => {
      rendered.dispose()
      resolve()
    })
    terminal.refresh(0, terminal.rows - 1)
  })

  expect(css(view.style.backgroundColor)).toBe(css(THEME.background))
  expect(css(view.style.color)).toBe(css(THEME.foreground))
})
