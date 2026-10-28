// @vitest-environment happy-dom

import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { resumePaneRendering, suspendPaneRendering } from './pane-rendering-control'
import { resetHiddenWebglRetentionForTest } from './terminal-webgl-hidden-retention'
import { isTerminalCursorBlinkSuspended } from './pane-cursor-blink-suspension'

/** Hidden panes must stop redraws and restore their exact cursor state. Assert rendered cursor classes, not options alone; a separate redraw counter covers WebGL’s document-focused timer leak. */

const COLS = 80
const ROWS = 24

type TestPane = ManagedPaneInternal & { host: HTMLElement }

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function flushRender(): Promise<void> {
  await nextFrame()
  await nextFrame()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function createTestPane(options: { cursorBlink?: boolean; webglAddon?: boolean } = {}): TestPane {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const terminal = new Terminal({
    cols: COLS,
    rows: ROWS,
    cursorBlink: options.cursorBlink ?? true,
    allowProposedApi: true
  })
  terminal.open(host)
  terminal.focus()
  const pane = {
    id: 1,
    terminal,
    host,
    container: host,
    xtermContainer: host,
    // Off so resume's reattachWebglIfNeeded leaves the DOM renderer in place;
    // the rendered-cursor oracle needs a renderer that paints in happy-dom.
    gpuRenderingEnabled: false,
    terminalGpuAcceleration: 'off',
    webglAddon: options.webglAddon ? ({ dispose: vi.fn() } as never) : null,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    webglAttachFailedSinceRecovery: false,
    hasComplexScriptOutput: false,
    pendingWebglRefreshRafId: null,
    pendingObservedFitRafId: null
  } as unknown as TestPane
  return pane
}

function renderedCursor(pane: TestPane): HTMLElement | null {
  return pane.host.querySelector('.xterm-cursor')
}

function rendersBlinkingCursor(pane: TestPane): boolean {
  return renderedCursor(pane)?.classList.contains('xterm-cursor-blink') === true
}

function renderedText(pane: TestPane): string {
  return pane.host.querySelector('.xterm-rows')?.textContent ?? ''
}

async function reveal(
  panes: TestPane[],
  owner?: Parameters<typeof resumePaneRendering>[1]
): Promise<void> {
  resumePaneRendering(panes, owner)
  for (const pane of panes) {
    pane.terminal.focus()
  }
}

describe('hidden-pane cursor blink suspension', () => {
  beforeEach(() => {
    resetHiddenWebglRetentionForTest()
    // happy-dom has no canvas text metrics; xterm measures glyphs on open().
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('renders a blinking cursor again one frame after reveal', async () => {
    const pane = createTestPane()
    await write(pane.terminal, 'ready$ ')
    await flushRender()
    expect(rendersBlinkingCursor(pane)).toBe(true)

    suspendPaneRendering([pane])
    expect(isTerminalCursorBlinkSuspended(pane.terminal)).toBe(true)

    await reveal([pane])
    await nextFrame()
    expect(renderedCursor(pane), 'reveal must not leave the pane without a cursor').not.toBeNull()
    expect(rendersBlinkingCursor(pane)).toBe(true)
    expect(isTerminalCursorBlinkSuspended(pane.terminal)).toBe(false)
  })

  it('keeps a user who disabled cursor blink un-blinking across hide and reveal', async () => {
    const pane = createTestPane({ cursorBlink: false })
    await write(pane.terminal, 'ready$ ')
    await flushRender()
    expect(rendersBlinkingCursor(pane)).toBe(false)

    suspendPaneRendering([pane])
    await reveal([pane])
    await flushRender()

    expect(renderedCursor(pane), 'a steady cursor must still be rendered').not.toBeNull()
    expect(rendersBlinkingCursor(pane), 'blink must stay off for this user').toBe(false)
  })

  it('does not drop output written while hidden, and echoes typing after reveal', async () => {
    const pane = createTestPane()
    await write(pane.terminal, 'before-hide\r\n')
    await flushRender()

    suspendPaneRendering([pane])
    await write(pane.terminal, 'while-hidden\r\n')

    await reveal([pane])
    await flushRender()
    expect(renderedText(pane)).toContain('before-hide')
    expect(renderedText(pane)).toContain('while-hidden')

    const typed: string[] = []
    pane.terminal.onData((data) => typed.push(data))
    const keydown = new KeyboardEvent('keydown', {
      key: 'x',
      code: 'KeyX',
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(keydown, 'keyCode', { value: 88 })
    pane.terminal.textarea?.dispatchEvent(keydown)
    expect(typed, 'keystrokes must still reach the PTY after a hide/reveal').toEqual(['x'])

    await write(pane.terminal, 'x')
    await flushRender()
    expect(renderedText(pane)).toContain('x')
    expect(rendersBlinkingCursor(pane)).toBe(true)
  })

  it('restores blink on the retained-hidden-WebGL path, which skips dispose', async () => {
    const owner = {}
    const pane = createTestPane({ webglAddon: true })
    const addon = pane.webglAddon
    await write(pane.terminal, 'ready$ ')
    await flushRender()

    suspendPaneRendering([pane], { owner, livePanes: () => [pane] })
    // Retention skips disposeWebgl, so only explicit blink suspension can stop this timer.
    expect(addon?.dispose).not.toHaveBeenCalled()
    expect(isTerminalCursorBlinkSuspended(pane.terminal)).toBe(true)

    await reveal([pane], owner)
    await nextFrame()
    expect(rendersBlinkingCursor(pane)).toBe(true)
  })

  it('restores every pane of a split, including one revealed a second time', async () => {
    const owner = {}
    const left = createTestPane()
    const right = createTestPane()
    const panes = [left, right]
    await write(left.terminal, 'left$ ')
    await write(right.terminal, 'right$ ')
    await flushRender()

    for (let cycle = 0; cycle < 2; cycle++) {
      suspendPaneRendering(panes, { owner, livePanes: () => panes })
      resumePaneRendering(panes, owner)
      // Focus split panes one at a time because DOM blink classes follow actual terminal focus.
      for (const [name, pane] of [
        ['left', left],
        ['right', right]
      ] as const) {
        pane.terminal.focus()
        await nextFrame()
        expect(renderedCursor(pane), `${name} cursor, cycle ${cycle}`).not.toBeNull()
        expect(rendersBlinkingCursor(pane), `${name} blink, cycle ${cycle}`).toBe(true)
      }
    }
    expect(renderedText(left)).toContain('left$')
    expect(renderedText(right)).toContain('right$')
  })

  it('does not re-arm a hidden pane when the blink setting changes mid-hide', async () => {
    const pane = createTestPane({ cursorBlink: false })
    suspendPaneRendering([pane])

    const { setTerminalCursorBlinkOption } = await import('./pane-cursor-blink-suspension')
    setTerminalCursorBlinkOption(pane.terminal, true)
    expect(
      pane.terminal.options.cursorBlink,
      'a hidden pane must not start blinking behind the surface'
    ).toBe(false)

    await reveal([pane])
    await nextFrame()
    expect(rendersBlinkingCursor(pane), 'the new setting applies on reveal').toBe(true)
  })

  it('resume is a no-op for a pane that was never suspended', async () => {
    const pane = createTestPane()
    await flushRender()
    await reveal([pane])
    await nextFrame()
    expect(rendersBlinkingCursor(pane)).toBe(true)
  })
})

/** Model addon-webgl 0.20’s 600ms document-focused timer, which redraws a full row per tick; DEC cursor mode overrides cursorBlink options. Read effective state from the real Terminal. */
const BLINK_INTERVAL_MS = 600

function blinkCellsRedrawnPerWindow(terminal: Terminal, windowMs: number): number {
  const decPrivateBlink = (
    terminal as unknown as {
      _core: { coreService: { decPrivateModes: { cursorBlink?: boolean } } }
    }
  )._core.coreService.decPrivateModes.cursorBlink
  const blinking = decPrivateBlink ?? terminal.options.cursorBlink === true
  if (!blinking) {
    return 0
  }
  return Math.floor(windowMs / BLINK_INTERVAL_MS) * terminal.cols
}

describe('hidden-pane cursor blink redraw cost', () => {
  beforeEach(() => {
    resetHiddenWebglRetentionForTest()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('drops retained hidden panes to zero blink redraws and restores them on reveal', async () => {
    const owner = {}
    const panes = Array.from({ length: 6 }, () => createTestPane({ webglAddon: true }))
    const windowMs = 30_000
    const cells = () =>
      panes.reduce((sum, pane) => sum + blinkCellsRedrawnPerWindow(pane.terminal, windowMs), 0)

    expect(cells()).toBe(6 * 50 * COLS)

    suspendPaneRendering(panes, { owner, livePanes: () => panes })
    expect(cells(), 'hidden panes must cost nothing while the window is visible').toBe(0)

    await reveal(panes, owner)
    expect(cells()).toBe(6 * 50 * COLS)
  })
})
