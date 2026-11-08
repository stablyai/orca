// @vitest-environment happy-dom
/** Midline preedit must show the covered committed tail as inserted text (#12545); use opaque live-theme colors to avoid exposing underlying cells. happy-dom tests supplied metrics; native geometry lives in terminal-korean-midline-preedit-occlusion.spec.ts. */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeCandidateAnchor } from '@/lib/pane-manager/terminal-ime-candidate-anchor'

const CELL_WIDTH_PX = 8
const CELL_HEIGHT_PX = 16
const THEME = { background: '#112233', cursor: '#ddeeff', foreground: '#aabbcc' }

const openTerminals: Terminal[] = []

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

type Rig = {
  compositionView: HTMLElement
  compose: (preedit: string) => void
  composeStart: () => void
  composeUpdate: (preedit: string) => void
  terminal: Terminal
  textarea: HTMLTextAreaElement
  write: (data: string) => Promise<void>
  writeAwaitingRender: (data: string) => Promise<void>
}

type RigOptions = {
  cursorWidth?: number
  theme?: { background: string; cursor?: string; foreground: string }
  /** Installs the production candidate-anchor listener, the other writer of `textarea.style`. */
  withCandidateAnchor?: boolean
}

/**
 * happy-dom lays nothing out, so both textarea-geometry owners read zeroes and neither can
 * overflow. This gives the preedit span a width and the screen its cols*rows box.
 */
function stubCompositionLayout(preeditWidth: () => number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('xterm-composition-preedit')) {
      return DOMRect.fromRect({ height: CELL_HEIGHT_PX, width: preeditWidth() })
    }
    if (this.classList.contains('xterm-screen')) {
      return DOMRect.fromRect({ height: 24 * CELL_HEIGHT_PX, width: 80 * CELL_WIDTH_PX })
    }
    return DOMRect.fromRect({ height: 0, width: 0 })
  })
}

function openTerminal(options: RigOptions = {}): Rig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    theme: options.theme ?? THEME,
    cursorWidth: options.cursorWidth
  })
  terminal.open(container)
  const textarea = terminal.textarea
  const compositionView = container.querySelector<HTMLElement>('.composition-view')
  if (!textarea || !compositionView) {
    throw new Error('xterm did not create the helper textarea and composition view')
  }
  openTerminals.push(terminal)
  if (options.withCandidateAnchor && !installTerminalImeCandidateAnchor(terminal)) {
    throw new Error('the candidate anchor did not install on an opened terminal')
  }

  const cell = (
    terminal as unknown as {
      _core: {
        _renderService: { dimensions: { css: { cell: { height: number; width: number } } } }
      }
    }
  )._core._renderService.dimensions.css.cell
  cell.width = CELL_WIDTH_PX
  cell.height = CELL_HEIGHT_PX

  const write = (data: string): Promise<void> =>
    new Promise((resolve) => terminal.write(data, resolve))

  // Subscribe after parsing before awaiting render so an earlier frame cannot supply stale tail text.
  const writeAwaitingRender = async (data: string): Promise<void> => {
    await write(data)
    await new Promise<void>((resolve) => {
      const rendered = terminal.onRender(() => {
        rendered.dispose()
        resolve()
      })
    })
  }

  const composeStart = (): void => {
    const start = new CompositionEvent('compositionstart', { bubbles: true })
    Object.defineProperty(start, 'data', { value: '' })
    textarea.dispatchEvent(start)
  }

  const composeUpdate = (preedit: string): void => {
    const update = new CompositionEvent('compositionupdate', { bubbles: true })
    Object.defineProperty(update, 'data', { value: preedit })
    textarea.value = preedit
    textarea.dispatchEvent(update)
  }

  const compose = (preedit: string): void => {
    composeStart()
    composeUpdate(preedit)
  }

  return {
    compositionView,
    compose,
    composeStart,
    composeUpdate,
    terminal,
    textarea,
    write,
    writeAwaitingRender
  }
}

function viewParts(compositionView: HTMLElement): {
  caret: HTMLElement | null
  preedit: HTMLElement | null
  remainder: HTMLElement | null
} {
  return {
    caret: compositionView.querySelector<HTMLElement>('.xterm-composition-caret'),
    preedit: compositionView.querySelector<HTMLElement>('.xterm-composition-preedit'),
    remainder: compositionView.querySelector<HTMLElement>('.xterm-composition-remainder')
  }
}

function stripMarks(text: string | null): string {
  return (text ?? '').replaceAll('‎', '')
}

describe('mid-line composition renders the covered row tail after the preedit', () => {
  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(async () => {
    // updateCompositionElements re-arms on a timer; let the pending one run before dispose.
    await nextEventLoop()
    await nextEventLoop()
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  // Install both textarea-position writers: candidate events write last, but xterm onRender can later overwrite them, so both must agree.
  it('keeps the caret and IME candidate anchor visible over committed text in the final cell', async () => {
    const rig = openTerminal({ cursorWidth: 2, withCandidateAnchor: true })
    await rig.write('x'.repeat(80))
    let preeditWidth = CELL_WIDTH_PX * 2
    stubCompositionLayout(() => preeditWidth)

    rig.compose('가')

    const { caret, remainder } = viewParts(rig.compositionView)
    expect(rig.terminal.buffer.active.cursorX).toBe(80)
    expect(remainder!.textContent).toBe('x')
    expect(remainder!.style.display).toBe('none')
    expect(rig.compositionView.style.maxWidth).toBe(`${CELL_WIDTH_PX}px`)
    expect(rig.compositionView.style.display).toBe('flex')
    expect(rig.compositionView.style.justifyContent).toBe('flex-end')
    expect(caret!.style.width).toBe('2px')
    expect(rig.textarea.style.left).toBe(`${rig.terminal.cols * CELL_WIDTH_PX - preeditWidth}px`)
    expect(rig.textarea.style.width).toBe(`${preeditWidth}px`)

    preeditWidth = CELL_WIDTH_PX / 2
    await rig.writeAwaitingRender('\x1b[0m')
    expect(remainder!.style.display).toBe('')
    expect(rig.compositionView.style.display).toBe('')
    expect(rig.compositionView.style.justifyContent).toBe('')
    expect(rig.textarea.style.left).toBe(`${(rig.terminal.cols - 1) * CELL_WIDTH_PX}px`)
    expect(rig.textarea.style.width).toBe(`${preeditWidth}px`)
  })

  it('refreshes the tail when the row repaints under an open composition', async () => {
    const rig = openTerminal()
    await rig.write('안녕하세요\x1b[6D')
    rig.compose('가')
    const original = viewParts(rig.compositionView)
    const glyphs = Array.from(original.preedit!.childNodes)

    // A TUI repaint: erase from the cursor, draw a different tail, put the cursor back.
    await rig.writeAwaitingRender('\x1b[K체크\x1b[4D')

    const { preedit, remainder } = viewParts(rig.compositionView)
    expect(stripMarks(preedit!.textContent)).toBe('가')
    expect(remainder!.textContent).toBe('체크')
    expect(preedit).toBe(original.preedit)
    expect(Array.from(preedit!.childNodes)).toEqual(glyphs)
    expect(viewParts(rig.compositionView).caret).toBe(original.caret)

    await rig.writeAwaitingRender('\x1b[K')
    expect(viewParts(rig.compositionView).remainder).toBeNull()
    expect(viewParts(rig.compositionView).preedit).toBe(original.preedit)
  })
})
