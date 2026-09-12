// @vitest-environment happy-dom
/**
 * The preedit overlay must be VISIBLE while the IME is still composing, not merely populated.
 *
 * Recorded shape: Windows 11 / MS Korean 2-Set typed into a WSL pane, captured as the DOM event
 * stream on the xterm helper textarea. Cited capture:
 * `.tmp/ime-handoff/evidence/11919-windows-wsl-current/11919-current-owner.json` (gitignored;
 * the subsequences below are copied verbatim from indices 240-253 and 79-92 of its `trace`).
 *
 * The capture contains a shape none of the Linux traces do: after `compositionend`, the IME
 * RESUMES the composition with a bare `compositionupdate` and **no second `compositionstart`**.
 * xterm hides the overlay in `compositionend` (`_finalizeComposition` drops `.active`) and only
 * ever re-adds it in `compositionstart`, so the resumed preedit is written into an element that
 * is still `display: none`. The syllable commits normally afterwards, which is exactly the
 * reported symptom: the committed text lands but the user types the next one blind.
 *
 * The first contract is the DISPLAYED overlay — the `active` class that CSS keys `display: block`
 * off, together with the text in it. The resumed update must also become a real transaction so its
 * later compositionend commits and cleans up normally.
 *
 * happy-dom performs no layout, so the cell size is supplied and geometry is not asserted.
 */
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

/**
 * Indices 240-253 of the capture: 네 commits, and the IME reopens on the next key with an
 * update alone. `keyCode: null` in the capture means the field was not recorded for that
 * event type, not that the event carried none.
 */
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

/** Indices 79-88: the same resume, this time across the Enter that committed 제. */
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

/** What the user sees: the class CSS keys `display: block` off, and the text inside it. */
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
