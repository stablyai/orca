// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discardTerminalOutput, writeTerminalOutput } from './pane-terminal-output-scheduler'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))

const START = '\x1b[?2026h'
const END = '\x1b[?2026l'
const captured = readFileSync(
  resolve('src/main/runtime/__fixtures__/codex-0157-plain-ready.txt'),
  'utf8'
)
const frames = captured
  .split(START)
  .slice(1)
  .map((frame) => frame.slice(0, frame.indexOf(END)))

let terminal: Terminal
let raf: Map<number, FrameRequestCallback>
let nextRaf: number
let originalGetContext: PropertyDescriptor | undefined

function renderFrame(): void {
  const pending = [...raf.values()]
  raf.clear()
  for (const callback of pending) {
    callback(performance.now())
  }
}

function write(data: string): void {
  let parsed = false
  writeTerminalOutput(terminal, data, {
    foreground: true,
    latencySensitive: true,
    forceForegroundRefresh: true,
    shouldRefreshForegroundSynchronously: () => false,
    onParsed: () => {
      parsed = true
    }
  })
  vi.advanceTimersByTime(0)
  expect(parsed).toBe(true)
}

describe('real xterm synchronized output between render opportunities', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    raf = new Map()
    nextRaf = 1
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextRaf++
      raf.set(id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      raf.delete(id)
    })
    originalGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({ measureText: () => ({ width: 10 }) })
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
    terminal.open(container)
    renderFrame()
  })

  afterEach(() => {
    discardTerminalOutput(terminal)
    terminal.dispose()
    if (originalGetContext) {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
    } else {
      Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext')
    }
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders complete captured Codex frames when RAF runs between them', () => {
    const rendered = vi.fn()
    terminal.onRender(rendered)
    for (const frame of frames) {
      write(START + frame + END)
      renderFrame()
    }
    expect(rendered).toHaveBeenCalledTimes(frames.length)
  })

  it('can suppress every paint beyond the safety timeout when the next frame starts before RAF', () => {
    const rendered = vi.fn()
    terminal.onRender(rendered)
    write(START)
    for (let index = 0; index < 100; index++) {
      // The PTY can deliver a completed frame and the next opening marker together.
      write(frames[index % frames.length]! + END + START)
      renderFrame()
      vi.advanceTimersByTime(16)
    }
    expect(rendered).not.toHaveBeenCalled()
    const screen = Array.from({ length: terminal.rows }, (_, row) =>
      terminal.buffer.active.getLine(row)?.translateToString(true)
    ).join('\n')
    expect(screen).toContain('Codex')
    write(END)
    renderFrame()
    expect(rendered).toHaveBeenCalledOnce()
  })
})
