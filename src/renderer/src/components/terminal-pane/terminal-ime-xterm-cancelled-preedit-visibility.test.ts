// @vitest-environment happy-dom
/** Covers #11951: cancelling Cangjie preedit must clear and hide xterm's overlay. */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CELL_WIDTH_PX = 8
const CELL_HEIGHT_PX = 16

type RecordedEvent = {
  data?: string
  inputType?: string
  isComposing?: boolean
  key?: string
  keyCode?: number
  type: string
  value?: string
}

/** Compose a single Cangjie radical: the preedit 尸 is showing and nothing is committed yet. */
const COMPOSE_RADICAL: RecordedEvent[] = [
  { type: 'keydown', key: 'Process', keyCode: 229, isComposing: false },
  { type: 'compositionstart', data: '' },
  { type: 'compositionupdate', data: '尸' },
  { type: 'beforeinput', data: '尸', isComposing: true },
  { type: 'input', data: '尸', isComposing: true, value: '尸' }
]

/** Backspace over the only radical: the IME drops the marked text and reports no composition end. */
const CANCEL_WITH_EMPTY_UPDATE: RecordedEvent[] = [
  { type: 'keydown', key: 'Process', keyCode: 229, isComposing: true },
  { type: 'compositionupdate', data: '' },
  { type: 'input', isComposing: true, inputType: 'deleteContentBackward', value: '' }
]

/** The same cancel from an IME that reports only the deletion, with no composition event at all. */
const CANCEL_WITH_INPUT_ONLY: RecordedEvent[] = [
  { type: 'keydown', key: 'Process', keyCode: 229, isComposing: true },
  { type: 'input', isComposing: true, inputType: 'deleteContentBackward', value: '' }
]

/** Backspace over one of several radicals: a preedit is still showing and must stay visible. */
const SHORTEN_PREEDIT: RecordedEvent[] = [
  { type: 'keydown', key: 'Process', keyCode: 229, isComposing: true },
  { type: 'compositionupdate', data: '尸' },
  { type: 'input', isComposing: true, inputType: 'deleteContentBackward', value: '尸' }
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
    Object.defineProperty(input, 'inputType', {
      value: recorded.inputType ?? 'insertCompositionText'
    })
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
  terminal.onData((data) => emitted.push(data))

  const replay = async (events: RecordedEvent[]): Promise<void> => {
    for (const recorded of events) {
      // Keys were physically separate, so each one began its own task.
      if (recorded.type === 'keydown' || recorded.type === 'keyup') {
        await nextEventLoop()
      }
      if (recorded.value !== undefined) {
        textarea.value = recorded.value
        textarea.setSelectionRange(recorded.value.length, recorded.value.length)
      }
      textarea.dispatchEvent(buildEvent(recorded))
    }
    // The overlay is re-derived on a deferred task, exactly as the position update is.
    await nextEventLoop()
    await nextEventLoop()
  }

  return { compositionView, emitted, replay }
}

function displayedPreedit(view: HTMLElement): {
  preedit: string
  shown: boolean
} {
  const shown = view.classList.contains('active')
  const preedit = (view.textContent ?? '').replaceAll('‎', '')
  return { preedit, shown }
}

describe('preedit visibility when the IME cancels a composition', () => {
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

  it('hides the preedit Backspace cancelled with an empty compositionupdate', async () => {
    const rig = openTerminal()

    await rig.replay(COMPOSE_RADICAL)
    expect(displayedPreedit(rig.compositionView)).toMatchObject({ preedit: '尸', shown: true })

    await rig.replay(CANCEL_WITH_EMPTY_UPDATE)

    expect(displayedPreedit(rig.compositionView)).toEqual({
      preedit: '',
      shown: false
    })
    expect(rig.emitted).toEqual([])
  })

  it('hides the preedit Backspace cancelled without any composition event', async () => {
    const rig = openTerminal()

    await rig.replay(COMPOSE_RADICAL)
    expect(displayedPreedit(rig.compositionView)).toMatchObject({ preedit: '尸', shown: true })

    await rig.replay(CANCEL_WITH_INPUT_ONLY)

    expect(displayedPreedit(rig.compositionView)).toEqual({
      preedit: '',
      shown: false
    })
    expect(rig.emitted).toEqual([])
  })

  it('keeps showing a preedit Backspace only shortened', async () => {
    const rig = openTerminal()

    await rig.replay([
      ...COMPOSE_RADICAL,
      { type: 'keydown', key: 'Process', keyCode: 229, isComposing: true },
      { type: 'compositionupdate', data: '尸口' },
      { type: 'input', data: '尸口', isComposing: true, value: '尸口' }
    ])

    await rig.replay(SHORTEN_PREEDIT)

    expect(displayedPreedit(rig.compositionView)).toMatchObject({ preedit: '尸', shown: true })
    expect(rig.emitted).toEqual([])
  })
})
