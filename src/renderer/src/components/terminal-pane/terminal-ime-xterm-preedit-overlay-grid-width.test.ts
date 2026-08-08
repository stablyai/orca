// @vitest-environment happy-dom
/**
 * The preedit overlay is laid out as plain text, so before the patch its extent was
 * the font's advance for the composed string rather than the cells that string will
 * occupy once committed. Measured in Electron 43 / Chromium 150 on macOS with Orca's
 * shipped stack (SF Mono 14px/300, cell 8.65x16), overlay width against
 * `wcwidth x cell.width`:
 *
 *   abcdefgh   69.234px / 69.20px = 1.000   (control)
 *   가나다라       48.453px / 69.20px = 0.700
 *   가나다라 committed  69.203px / 69.20px = 1.000
 *   日本語       42.000px / 51.90px = 0.809
 *
 * The same four syllables render 30% narrower while composing than they do once the
 * terminal paints them, drifting 20.75px by the fourth. The patch spreads the
 * shortfall as letter-spacing, the mechanism DomRendererRowFactory already uses to
 * land committed glyphs on the grid.
 *
 * Caveat: those pixel ratios are macOS/SF Mono. STA-3232's reporter is on Windows,
 * whose font stack was not measured; the arithmetic asserted here is font-independent,
 * the visual consequence is not.
 *
 * happy-dom has no text layout, so the font advances below stand in for it — the
 * assertions are about the width the patch derives, not about real glyph rasterisation.
 */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Per-character advances measured in the Chromium rig, keyed by script. */
const LATIN_ADVANCE_PX = 8.654
const HANGUL_ADVANCE_PX = 12.125
const CJK_ADVANCE_PX = 14

const CELL_WIDTH_PX = 8.65
const CELL_HEIGHT_PX = 16

function advanceOf(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0
  if (codePoint >= 0x3040 && codePoint <= 0x9fff) {
    return CJK_ADVANCE_PX
  }
  if (codePoint >= 0x1100 && codePoint <= 0x11ff) {
    return HANGUL_ADVANCE_PX
  }
  if (codePoint >= 0x3130 && codePoint <= 0x318f) {
    return HANGUL_ADVANCE_PX
  }
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) {
    return HANGUL_ADVANCE_PX
  }
  // The U+200E marks xterm wraps the preedit in take no advance and no spacing.
  if (codePoint === 0x200e) {
    return 0
  }
  return LATIN_ADVANCE_PX
}

/**
 * Chromium's own rule, confirmed against the rig: letter-spacing lands after every
 * character that advances and after none that does not.
 */
function laidOutWidth(view: HTMLElement): number {
  const spacing = Number.parseFloat(view.style.letterSpacing || '0') || 0
  let width = 0
  for (const character of view.textContent ?? '') {
    const advance = advanceOf(character)
    if (advance > 0) {
      width += advance + spacing
    }
  }
  return width
}

type Harness = {
  cell: { width: number; height: number }
  compose: (data: string) => void
  terminal: Terminal
  view: HTMLElement
}

const openTerminals: { terminal: Terminal; textarea: HTMLTextAreaElement }[] = []

function openComposingTerminal(): Harness {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 24 })
  terminal.open(container)
  const textarea = terminal.textarea
  const view = container.querySelector<HTMLElement>('.composition-view')
  if (!textarea || !view) {
    throw new Error('xterm did not create the helper textarea and composition view')
  }
  openTerminals.push({ terminal, textarea })

  // happy-dom measures no text, so the terminal's own cell size has to be supplied.
  const cell = (
    terminal as unknown as {
      _core: {
        _renderService: { dimensions: { css: { cell: { height: number; width: number } } } }
      }
    }
  )._core._renderService.dimensions.css.cell
  cell.width = CELL_WIDTH_PX
  cell.height = CELL_HEIGHT_PX

  view.getBoundingClientRect = () =>
    ({ height: CELL_HEIGHT_PX, width: laidOutWidth(view) }) as DOMRect

  const compose = (data: string): void => {
    const event = new CompositionEvent('compositionupdate', { bubbles: true })
    Object.defineProperty(event, 'data', { value: data })
    textarea.dispatchEvent(event)
  }
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  return { cell, compose, terminal, view }
}

/** What xterm's own unicode service says the string occupies in the grid. */
function gridWidthPx(terminal: Terminal, text: string, cellWidth = CELL_WIDTH_PX): number {
  const unicodeService = (
    terminal as unknown as {
      _core: { unicodeService: { getStringCellWidth: (s: string) => number } }
    }
  )._core.unicodeService
  return unicodeService.getStringCellWidth(text) * cellWidth
}

describe('preedit overlay grid width', () => {
  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(async () => {
    // updateCompositionElements re-arms itself on a timer, so end the composition and
    // let the pending one run before the render service it reads goes away.
    for (const { textarea } of openTerminals) {
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    while (openTerminals.length > 0) {
      openTerminals.pop()?.terminal.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('sizes a Korean preedit to the cells it will occupy once committed', () => {
    const { compose, terminal, view } = openComposingTerminal()

    compose('가나다라')

    // 4 syllables x 2 cells x 8.65 = 69.2, against a 48.5 natural advance.
    expect(gridWidthPx(terminal, '가나다라')).toBeCloseTo(69.2, 6)
    expect(laidOutWidth(view)).toBeCloseTo(69.2, 6)
    // (69.2 - 4 x 12.125) / 4 gaps
    expect(Number.parseFloat(view.style.letterSpacing)).toBeCloseTo(5.175, 6)
  })

  it('leaves a Latin preedit at the width it already had', () => {
    const { compose, terminal, view } = openComposingTerminal()

    compose('abcdefgh')

    expect(laidOutWidth(view)).toBeCloseTo(gridWidthPx(terminal, 'abcdefgh'), 6)
    // The control arm measured 1.000 before the patch; the correction must stay in the noise.
    expect(Math.abs(Number.parseFloat(view.style.letterSpacing))).toBeLessThan(0.01)
  })

  it('sizes a CJK preedit to the cells it will occupy once committed', () => {
    const { compose, terminal, view } = openComposingTerminal()

    compose('日本語')

    expect(gridWidthPx(terminal, '日本語')).toBeCloseTo(51.9, 6)
    expect(laidOutWidth(view)).toBeCloseTo(51.9, 6)
  })

  it('resizes when the composition grows a syllable at a time', () => {
    const { compose, terminal, view } = openComposingTerminal()

    for (const preedit of ['ㅇ', '아', '안', '안ㄴ', '안녕']) {
      compose(preedit)
      expect(laidOutWidth(view)).toBeCloseTo(gridWidthPx(terminal, preedit), 6)
    }
  })

  it('re-derives the width when the cell size changes under an unchanged preedit', () => {
    const { cell, compose, terminal, view } = openComposingTerminal()

    compose('가나다라')
    cell.width = 12
    compose('가나다라')

    expect(laidOutWidth(view)).toBeCloseTo(gridWidthPx(terminal, '가나다라', 12), 6)
  })

  it('leaves an empty preedit alone', () => {
    const { compose, view } = openComposingTerminal()

    compose('')

    expect(view.style.letterSpacing).toBe('')
  })
})
