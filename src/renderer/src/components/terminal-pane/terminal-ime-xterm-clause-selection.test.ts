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

/** Each preedit character's letter-spacing, i.e. its advance correction onto the cell grid. */
function advanceCorrections(): string[] {
  const preedit = terminal.element!.querySelector('.xterm-composition-preedit')!
  return Array.from(preedit.childNodes).flatMap((node) =>
    Array.from(node.textContent ?? '', () =>
      node instanceof HTMLElement ? node.style.letterSpacing : ''
    )
  )
}

it.each([false, true])(
  'highlights each clause the IME selects without sending it (screenReaderMode: %s)',
  async (screenReaderMode) => {
    openComposition({ screenReaderMode })
    for (const [preedit, start, end] of [
      ['今日はいい天気です', 0, 3],
      ['今日はいい天気です', 3, 9],
      ['きょうはいいてんきです', 0, 5]
    ] as const) {
      updatePreedit(preedit)
      selectClause(start, end)
      // xterm re-lays out the preedit one task after every update.
      await new Promise((resolve) => setTimeout(resolve))
      expect(highlighted()).toBe(preedit.slice(start, end))
    }
    expect(sent).toEqual([])
  }
)

it('drops the highlight when the IME replaces the preedit', () => {
  openComposition()
  updatePreedit('きょう')
  selectClause(0, 3)
  updatePreedit('きょうは')
  expect(highlighted()).toBe('')
})

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

it.each([
  ['that starts in committed text', '今日は', -1, 2],
  ['that runs past the preedit', '今日はx', 2, 4],
  ['in a textarea that no longer holds the preedit', 'きょう', 0, 2]
])('ignores a selection %s', (_selection, textarea, start, end) => {
  openComposition()
  updatePreedit('今日は', textarea)
  selectClause(start, end)
  expect(highlighted()).toBe('')
})

it.each([
  ['selectionForeground', { selectionForeground: '#abcdef' }, '#abcdef'],
  ['foreground when selectionForeground is unset', { foreground: '#fedcba' }, '#fedcba']
])(
  'colors the highlight with selectionBackground and the theme %s',
  (_source, theme, foreground) => {
    openComposition({ theme: { selectionBackground: '#123456', ...theme } })
    updatePreedit('今日は')
    const view = terminal.element!.querySelector<HTMLElement>('.composition-view')!
    expect(view.style.getPropertyValue('--xterm-composition-selection-background')).toBe('#123456')
    expect(view.style.getPropertyValue('--xterm-composition-selection-foreground')).toBe(foreground)
  }
)

it.each([
  { where: 'inside the corrected prefix', start: 10, end: 20 },
  { where: 'past the layout budget', start: 252, end: 255 }
])(
  'highlights a clause $where without moving any character off the cell grid',
  ({ start, end }) => {
    const text = Array.from({ length: 256 }, (_, index) =>
      String.fromCodePoint(0x4e00 + index)
    ).join('')
    openComposition()
    updatePreedit(text)
    const corrections = advanceCorrections()
    selectClause(start, end)
    expect(highlighted()).toBe(text.slice(start, end))
    expect(advanceCorrections()).toEqual(corrections)
  }
)
