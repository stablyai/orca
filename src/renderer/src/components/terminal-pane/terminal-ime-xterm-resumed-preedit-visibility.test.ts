// @vitest-environment happy-dom
/** Exercise synthetic resume-without-start ordering; resumed updates must reopen visible preedit and create a transaction that commits/cleans up. Real dispatch-only Windows traces cover balanced sessions separately; happy-dom supplies metrics without layout. */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CELL_WIDTH_PX = 8
const CELL_HEIGHT_PX = 16

type RecordedEvent = {
  type: string
  data?: string
  key?: string
  keyCode?: number
  isComposing?: boolean
}

// Synthetic update-only resume after 네 commits; null keyCode denotes an unrecorded field, not an absent browser value.
const RESUMED_WITHOUT_START: RecordedEvent[] = [
  { type: 'keydown', key: 'Process', keyCode: 229, isComposing: true },
  { type: 'compositionupdate', data: '네' },
  { type: 'beforeinput', data: '네', isComposing: true },
  { type: 'input', data: '네', isComposing: true },
  { type: 'compositionend', data: '네' },
  { type: 'keydown', key: 'Process', keyCode: 229, isComposing: true },
  { type: 'compositionupdate', data: '네' },
  { type: 'beforeinput', data: '네', isComposing: true },
  { type: 'input', data: '네', isComposing: true }
]

// Synthetic update-only resume across the Enter committing 제.
const RESUMED_ACROSS_ENTER: RecordedEvent[] = [
  { type: 'input', data: '제', isComposing: true },
  { type: 'compositionend', data: '제' },
  { type: 'keydown', key: 'Enter', keyCode: 13, isComposing: false },
  { type: 'keyup', key: 'Process', keyCode: 229, isComposing: false },
  { type: 'keyup', key: 'Enter', keyCode: 13, isComposing: false },
  { type: 'keydown', key: 'Process', keyCode: 229, isComposing: true },
  { type: 'compositionupdate', data: '제' },
  { type: 'beforeinput', data: '제', isComposing: true },
  { type: 'input', data: '제', isComposing: true }
]

/** The Linux control: IBus always reopens with a compositionstart, and must stay working. */
const REOPENED_WITH_START: RecordedEvent[] = [
  { type: 'keydown', key: 'Process', keyCode: 229, isComposing: true },
  { type: 'compositionupdate', data: '한' },
  { type: 'compositionend', data: '한' },
  { type: 'keydown', key: 'Process', keyCode: 229, isComposing: false },
  { type: 'compositionstart', data: '' },
  { type: 'compositionupdate', data: '글' }
]

const openTerminals: Terminal[] = []

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function buildEvent(recorded: RecordedEvent): Event {
  if (recorded.type === 'keydown' || recorded.type === 'keyup') {
    const keyboard = new KeyboardEvent(recorded.type, {
      bubbles: true,
      cancelable: true,
      isComposing: recorded.isComposing,
      key: recorded.key ?? ''
    })
    Object.defineProperty(keyboard, 'keyCode', { value: recorded.keyCode })
    return keyboard
  }
  if (recorded.type === 'input' || recorded.type === 'beforeinput') {
    const input = new InputEvent(recorded.type, {
      bubbles: true,
      isComposing: recorded.isComposing
    })
    // happy-dom drops these from InputEventInit; Chromium supplies them.
    Object.defineProperty(input, 'inputType', { value: 'insertCompositionText' })
    Object.defineProperty(input, 'data', { value: recorded.data ?? null })
    Object.defineProperty(input, 'composed', { value: true })
    return input
  }
  const composition = new CompositionEvent(recorded.type, { bubbles: true })
  Object.defineProperty(composition, 'data', { value: recorded.data ?? '' })
  return composition
}

type Rig = {
  compositionView: HTMLElement
  emitted: string[]
  replay: (events: RecordedEvent[]) => Promise<void>
  terminal: Terminal
}

function openTerminal(): Rig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 24 })
  terminal.open(container)
  const textarea = terminal.textarea
  const compositionView = container.querySelector<HTMLElement>('.composition-view')
  if (!textarea || !compositionView) {
    throw new Error('xterm did not create the helper textarea and composition view')
  }
  openTerminals.push(terminal)

  const cell = (
    terminal as unknown as {
      _core: {
        _renderService: { dimensions: { css: { cell: { height: number; width: number } } } }
      }
    }
  )._core._renderService.dimensions.css.cell
  cell.width = CELL_WIDTH_PX
  cell.height = CELL_HEIGHT_PX
  const emitted: string[] = []
  terminal.onData((data) => {
    emitted.push(data)
    terminal.write(data)
  })

  const replay = async (events: RecordedEvent[]): Promise<void> => {
    for (const recorded of events) {
      // Keys were physically separate, so each one began its own task.
      if (recorded.type === 'keydown' || recorded.type === 'keyup') {
        await nextEventLoop()
      }
      if (recorded.data !== undefined && recorded.type !== 'compositionupdate') {
        textarea.value = recorded.data
        textarea.setSelectionRange(recorded.data.length, recorded.data.length)
      }
      textarea.dispatchEvent(buildEvent(recorded))
    }
  }

  return { compositionView, emitted, replay, terminal }
}

function displayedPreedit(view: HTMLElement): { preedit: string; shown: boolean } {
  return {
    preedit: (view.textContent ?? '').replaceAll('‎', ''),
    shown: view.classList.contains('active')
  }
}

describe('preedit visibility across a composition the IME resumes', () => {
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

  it('shows a preedit the IME resumes with an update and no second compositionstart', async () => {
    const rig = openTerminal()

    await rig.replay(RESUMED_WITHOUT_START)

    expect(displayedPreedit(rig.compositionView)).toEqual({ preedit: '네', shown: true })
  })

  it('commits and cleans up a transaction resumed with an update alone', async () => {
    const rig = openTerminal()

    await rig.replay([
      { type: 'compositionstart', data: '' },
      ...RESUMED_WITHOUT_START,
      { type: 'compositionend', data: '네' }
    ])
    await nextEventLoop()
    await nextEventLoop()

    expect(rig.emitted.join('')).toBe('네네')
    expect(displayedPreedit(rig.compositionView)).toEqual({ preedit: '', shown: false })
  })

  it('shows a preedit the IME resumes after the Enter that committed the last syllable', async () => {
    const rig = openTerminal()

    await rig.replay(RESUMED_ACROSS_ENTER)

    expect(displayedPreedit(rig.compositionView)).toEqual({ preedit: '제', shown: true })
  })

  it('still shows a preedit the IME reopens with a compositionstart', async () => {
    const rig = openTerminal()

    await rig.replay(REOPENED_WITH_START)

    expect(displayedPreedit(rig.compositionView)).toEqual({ preedit: '글', shown: true })
  })

  it('hides the overlay once the composition ends and nothing resumes it', async () => {
    const rig = openTerminal()

    await rig.replay([
      { type: 'compositionstart', data: '' },
      { type: 'compositionupdate', data: '한' },
      { type: 'compositionend', data: '한' }
    ])

    expect(displayedPreedit(rig.compositionView).shown).toBe(false)
  })
})
