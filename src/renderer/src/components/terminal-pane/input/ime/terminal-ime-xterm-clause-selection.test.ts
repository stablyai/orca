// @vitest-environment happy-dom
import { Terminal, type ITerminalOptions } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Text an earlier commit left in xterm's textarea; Chromium reports clause offsets past it.
const committed = 'ls\n'

let terminal: Terminal
let sent: string[]

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const context: CanvasRenderingContext2D = Object.create(null)
    context.measureText = () => Object.assign(Object.create(null), { width: 10 })
    return context
  })
  sent = []
})

afterEach(() => {
  terminal.dispose()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

// happy-dom drops these fields from event init dictionaries; Chromium supplies them.
function dispatch(event: Event, fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(event, key, { value })
  }
  terminal.textarea!.dispatchEvent(event)
}

function openComposition(options: ITerminalOptions = {}): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  terminal = new Terminal(options)
  terminal.open(container)
  terminal.onData((data) => sent.push(data))
  terminal.textarea!.value = committed
  terminal.textarea!.setSelectionRange(committed.length, committed.length)
  dispatch(new CompositionEvent('compositionstart'), { data: '' })
}

function updatePreedit(text: string, textarea = text): void {
  terminal.textarea!.value = committed + textarea
  dispatch(new CompositionEvent('compositionupdate'), { data: text })
}

/** Chromium's insertCompositionText input, with the IME's clause as the textarea selection. */
function selectClause(start: number, end: number): void {
  terminal.textarea!.setSelectionRange(committed.length + start, committed.length + end)
  dispatch(new InputEvent('input'), { inputType: 'insertCompositionText', composed: true })
}

function highlighted(): string {
  return Array.from(
    terminal.element!.querySelectorAll('.xterm-composition-preedit-selected'),
    (span) => span.textContent
  ).join('')
}

it('highlights a whole grapheme when a clause boundary falls inside it, but not a caret', () => {
  openComposition()
  updatePreedit('か\u3099X')
  for (const [start, end, expected] of [
    [0, 1, 'か\u3099'],
    [1, 2, 'か\u3099'],
    [1, 1, '']
  ] as const) {
    selectClause(start, end)
    expect(highlighted()).toBe(expected)
  }
})
