// @vitest-environment happy-dom
/**
 * The behaviour the option actually buys: xterm keeps a live DOM of the visible rows -- a
 * `role="list"` with one `role="listitem"` per row -- and builds it only while screenReaderMode is
 * on. Orca never turned it on, so there was nothing for an assistive client to read.
 *
 * Structure rather than row text: populating the items runs off the renderer's refresh, which needs
 * a real paint. What this pins is the half that the option decides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { applyScreenReaderMode, setScreenReaderModePreference } from './pane-screen-reader-mode'
import { buildDefaultTerminalOptions } from './pane-terminal-options'

const ROWS = 8
const openTerminals: Terminal[] = []

function openTerminal(): { container: HTMLElement; terminal: Terminal } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  // Takes screenReaderMode from the factory createPaneDOM builds its options with, so the seeding
  // path is the one under test. The rest of the defaults are left out: their font metrics drag the
  // DOM renderer's width cache through a 2d context happy-dom does not have.
  const terminal = new Terminal({
    cols: 40,
    rows: ROWS,
    screenReaderMode: buildDefaultTerminalOptions().screenReaderMode
  })
  openTerminals.push(terminal)
  terminal.open(container)
  return { container, terminal }
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function readableRows(container: HTMLElement): number | null {
  const tree = container.querySelector('.xterm-accessibility-tree')
  return tree ? tree.querySelectorAll('[role="listitem"]').length : null
}

describe('screen reader mode on a live pane', () => {
  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    for (const terminal of openTerminals.splice(0)) {
      terminal.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('exposes the rows to assistive clients only once it is on', async () => {
    const { container, terminal } = openTerminal()
    await write(terminal, 'orca build --watch\r\n')
    // Before: no tree at all. This is every pane in Orca today.
    expect(readableRows(container)).toBeNull()

    applyScreenReaderMode([terminal], true)
    await write(terminal, 'listening on 3000\r\n')
    expect(readableRows(container)).toBe(ROWS)
  })

  it('takes the tree back down when the assistive client detaches', async () => {
    const { container, terminal } = openTerminal()
    applyScreenReaderMode([terminal], true)
    await write(terminal, 'orca build --watch\r\n')
    expect(readableRows(container)).toBe(ROWS)

    applyScreenReaderMode([terminal], false)
    expect(readableRows(container)).toBeNull()
  })

  it('opens a pane readable when the mode was already settled', async () => {
    setScreenReaderModePreference('on')
    const { container, terminal } = openTerminal()
    await write(terminal, 'orca build --watch\r\n')
    expect(readableRows(container)).toBe(ROWS)
    setScreenReaderModePreference('auto')
  })
})
