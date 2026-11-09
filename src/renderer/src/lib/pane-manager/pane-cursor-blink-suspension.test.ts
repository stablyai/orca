// @vitest-environment happy-dom

import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { resumePaneRendering, suspendPaneRendering } from './pane-rendering-control'
import {
  resetHiddenWebglRetentionForTest,
  retainedHiddenWebglOwnerCountForTest
} from './terminal-webgl-hidden-retention'
import {
  isTerminalCursorBlinkSuspended,
  setTerminalCursorBlinkOption
} from './pane-cursor-blink-suspension'

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

function createTestPane(options: { cursorBlink?: boolean } = {}): TestPane {
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this DOM fixture provides the fields used by suspend/resume.
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
    webglAddon: null,
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

async function reveal(panes: TestPane[]): Promise<void> {
  resumePaneRendering(panes)
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
    // DOM blink is focus-gated CSS; toggling the option would rewrite xterm's stylesheet on every switch.
    expect(isTerminalCursorBlinkSuspended(pane.terminal)).toBe(false)
    expect(pane.terminal.options.cursorBlink).toBe(true)

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

  it.each([false, true])(
    'restores a retained WebGL pane whose initial blink setting was %s after a mid-hide change',
    async (initialBlink) => {
      const pane = createTestPane({ cursorBlink: initialBlink })
      const addon = { dispose: vi.fn() }
      Object.assign(pane, { webglAddon: addon })
      const owner = {}
      const retention = { owner, livePanes: () => [pane] }

      suspendPaneRendering([pane], retention)
      expect(pane.webglAddon).toBe(addon)
      expect(addon.dispose).not.toHaveBeenCalled()
      expect(retainedHiddenWebglOwnerCountForTest()).toBe(1)
      expect(isTerminalCursorBlinkSuspended(pane.terminal)).toBe(true)
      expect(pane.terminal.options.cursorBlink).toBe(false)

      setTerminalCursorBlinkOption(pane.terminal, !initialBlink)
      suspendPaneRendering([pane], retention)
      expect(pane.terminal.options.cursorBlink).toBe(false)
      expect(retainedHiddenWebglOwnerCountForTest()).toBe(1)

      resumePaneRendering([pane], owner)
      pane.terminal.focus()
      await nextFrame()
      expect(retainedHiddenWebglOwnerCountForTest()).toBe(0)
      expect(pane.webglAddon).toBe(addon)
      expect(addon.dispose).not.toHaveBeenCalled()
      expect(isTerminalCursorBlinkSuspended(pane.terminal)).toBe(false)
      expect(pane.terminal.options.cursorBlink).toBe(!initialBlink)
      expect(rendersBlinkingCursor(pane)).toBe(!initialBlink)
    }
  )

  it('parks only the WebGL cursor in a mixed-renderer split and blurs both panes', async () => {
    const domPane = createTestPane()
    const webglPane = createTestPane()
    const addon = { dispose: vi.fn() }
    Object.assign(webglPane, { webglAddon: addon })
    const panes = [domPane, webglPane]
    const owner = {}

    suspendPaneRendering(panes, { owner, livePanes: () => panes })
    await nextFrame()

    expect(domPane.terminal.options.cursorBlink).toBe(true)
    expect(isTerminalCursorBlinkSuspended(domPane.terminal)).toBe(false)
    expect(webglPane.terminal.options.cursorBlink).toBe(false)
    expect(isTerminalCursorBlinkSuspended(webglPane.terminal)).toBe(true)
    for (const pane of panes) {
      expect(pane.host.querySelector('.xterm-rows')?.classList.contains('xterm-focus')).toBe(false)
      expect(document.activeElement).not.toBe(pane.terminal.textarea)
    }

    resumePaneRendering(panes, owner)
    expect(domPane.terminal.options.cursorBlink).toBe(true)
    expect(webglPane.terminal.options.cursorBlink).toBe(true)
    expect(isTerminalCursorBlinkSuspended(webglPane.terminal)).toBe(false)
    expect(webglPane.webglAddon).toBe(addon)
    expect(addon.dispose).not.toHaveBeenCalled()
  })
})
