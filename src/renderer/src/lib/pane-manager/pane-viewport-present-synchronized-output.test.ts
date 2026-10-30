// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import type { ManagedPaneInternal } from './pane-manager-types'
import { presentPaneViewport } from './pane-viewport-present'

const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const ERASE_LINE = '\x1b[K'
// xterm's SynchronizedOutputHandler safety timeout.
const XTERM_SYNCHRONIZED_OUTPUT_TIMEOUT_MS = 1_000

// Codex 0.158 wraps each redraw in DEC 2026 and erases rows before repainting them.
function firstCodexFrameWithErase(): { erased: string; rest: string } {
  const transcript = readFileSync(
    join(__dirname, '../../../../main/runtime/__fixtures__/codex-0-158-0-timed-turn.txt'),
    'utf8'
  )
  for (const block of transcript.split(SYNC_START).slice(1)) {
    const body = block.split(SYNC_END)[0]
    const erase = body.indexOf(ERASE_LINE)
    if (erase > 0 && !body.includes('\x1b[?1049h')) {
      const cut = erase + ERASE_LINE.length
      return { erased: body.slice(0, cut), rest: body.slice(cut) }
    }
  }
  throw new Error('fixture has no erasing synchronized frame')
}

// Step fake timers so xterm’s asynchronous writes reach their callbacks.
async function write(terminal: Terminal, data: string): Promise<void> {
  let parsed = false
  terminal.write(data, () => {
    parsed = true
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(parsed).toBe(true)
}

function createPane(terminal: Terminal, container: HTMLElement): ManagedPaneInternal {
  const leafId = '11111111-1111-4111-8111-111111111111'
  if (!isTerminalLeafId(leafId)) {
    throw new Error('Expected a valid fixture leaf id')
  }
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal,
    container,
    xtermContainer: container,
    linkTooltip: document.createElement('div'),
    fitAddon: new FitAddon(),
    searchAddon: new SearchAddon(),
    serializeAddon: new SerializeAddon(),
    unicode11Addon: new Unicode11Addon(),
    webLinksAddon: new WebLinksAddon(),
    terminalGpuAcceleration: 'off',
    gpuRenderingEnabled: false,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: null,
    imageAddon: null,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

const COHERENT_TEXT = 'COHERENT FRAME'

describe('presentPaneViewport during synchronized output', () => {
  const originalGetContext = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    'getContext'
  )
  let terminal: Terminal
  let pane: ManagedPaneInternal
  // What the DOM renderer has put on screen, not the parsed buffer.
  const screenText = (): string => pane.container.querySelector('.xterm-rows')?.textContent ?? ''

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame'] })
    // Why: happy-dom has no canvas text metrics; xterm measures glyphs on open().
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({ measureText: () => ({ width: 10 }) })
    })
    const container = document.createElement('div')
    document.body.append(container)
    terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
    terminal.open(container)
    pane = createPane(terminal, container)
    await write(terminal, `\x1b[5;2H${COHERENT_TEXT}`)
    await vi.advanceTimersByTimeAsync(50)
    expect(screenText()).toContain(COHERENT_TEXT)
  })

  afterEach(() => {
    terminal.dispose()
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalGetContext) {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
    }
  })

  it('keeps the last coherent frame until the agent closes its redraw', async () => {
    const frame = firstCodexFrameWithErase()
    await write(terminal, SYNC_START + frame.erased)

    presentPaneViewport(pane)
    await vi.advanceTimersByTimeAsync(50)
    expect(screenText()).toContain(COHERENT_TEXT)

    await write(terminal, frame.rest + SYNC_END)
    await vi.advanceTimersByTimeAsync(50)
    expect(screenText()).not.toContain(COHERENT_TEXT)
  })

  it('still paints a frame the agent never closes once xterm times out', async () => {
    const frame = firstCodexFrameWithErase()
    await write(terminal, SYNC_START + frame.erased)

    presentPaneViewport(pane)
    await vi.advanceTimersByTimeAsync(XTERM_SYNCHRONIZED_OUTPUT_TIMEOUT_MS - 1)
    expect(screenText()).toContain(COHERENT_TEXT)
    await vi.advanceTimersByTimeAsync(50)
    expect(screenText()).not.toContain(COHERENT_TEXT)
  })
})
