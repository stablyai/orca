// @vitest-environment happy-dom
/**
 * STA-3132 (overlap arm) / STA-3170 / STA-3232 (overlap arm) — the Korean preedit is
 * painted on a cell that a committed-but-unflushed syllable is about to occupy.
 *
 * Recorded shape: Windows 11 / MS Korean 2-Set, `가나다라` injected one key at a time with
 * real scan codes at a `KO> ` prompt in Orca's terminal, DOM events and geometry recorded
 * between keystrokes on two shipped builds. The event stream replayed below is the one in
 * `.tmp/ime-handoff/swarm-scratch/wave5-r2/evidence/ko164.json.events`, in its recorded order.
 * Raw capture: `.tmp/ime-handoff/swarm-scratch/wave5-r2/evidence/{ko164,ko176,en176}.json`.
 *
 *   build            cursorX per key            row while 라 composes
 *   v1.4.176 (fixed) 4,4,4,6,6,8,8,10           `KO> 가나다`
 *   v1.4.164 (defect) 4,4,4,4,4,6,6,8           `KO> 가나`
 *
 * The IME has committed three syllables in both runs (3 compositionend events), but on
 * 164 only two reached the screen, so the overlay for 라 sits at column 8 — exactly the
 * cell 다 lands in when it finally flushes. That collision is the reported overlap.
 *
 * The assertion is therefore between the terminal's committed CONTENT and the cell the
 * overlay occupies. It is deliberately NOT `left` against `buffer.x`: the helper computes
 * `left = buffer.x * cellWidth`, so those two agree by construction on the broken build
 * too, and the capture records that column as proving nothing.
 *
 * Two modelling choices, stated rather than hidden:
 *  - The terminal only advances its cursor when bytes come back from the PTY. The capture
 *    ran against a shell echoing at a prompt; that is modelled here as local echo.
 *  - happy-dom performs no layout, so the recorded cell size (8x16 px) is supplied to the
 *    render service. The pixel below is still produced by the helper, not by the test.
 * Both are validated by the harness reproducing the recorded cursorX and row text exactly.
 */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Recorded on both builds: `cell: { width: 8, height: 16 }`. */
const CELL_WIDTH_PX = 8
const CELL_HEIGHT_PX = 16
const PROMPT = 'KO> '
/** Recorded `rowCells` indices for `가나다` are 4, 6, 8 — one syllable is two cells. */
const CELLS_PER_SYLLABLE = 2

type ObservedEvent = { isComposing: boolean; keyCode: number | undefined; type: string }

/** Every event type the Windows capture listened for, so the rig is graded on all of them. */
const RECORDED_EVENT_TYPES = [
  'beforeinput',
  'compositionend',
  'compositionstart',
  'compositionupdate',
  'input',
  'keydown',
  'keyup'
] as const

type Sample = {
  cursorX: number
  overlayActive: boolean
  overlayCell: number
  overlayText: string
  rowText: string
}

type EchoTerminal = {
  events: ObservedEvent[]
  ready: () => Promise<void>
  sample: () => Sample
  terminal: Terminal
  textarea: HTMLTextAreaElement
}

const openTerminals: { terminal: Terminal; textarea: HTMLTextAreaElement }[] = []

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function cellSizeOf(terminal: Terminal): { height: number; width: number } {
  return (
    terminal as unknown as {
      _core: {
        _renderService: { dimensions: { css: { cell: { height: number; width: number } } } }
      }
    }
  )._core._renderService.dimensions.css.cell
}

/**
 * The composition helper is only reachable through real events on xterm's helper textarea,
 * so the terminal is driven end to end: events in, `onData` echoed back in as PTY output.
 */
function openEchoTerminal(): EchoTerminal {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 24 })
  terminal.open(container)
  const textarea = terminal.textarea
  const view = container.querySelector<HTMLElement>('.composition-view')
  if (!textarea || !view) {
    throw new Error('xterm did not create the helper textarea and composition view')
  }
  openTerminals.push({ terminal, textarea })

  const events: ObservedEvent[] = []
  for (const type of RECORDED_EVENT_TYPES) {
    textarea.addEventListener(
      type,
      (event) => {
        events.push({
          isComposing: (event as { isComposing?: boolean }).isComposing === true,
          keyCode: (event as KeyboardEvent).keyCode,
          type: event.type
        })
      },
      true
    )
  }

  terminal.onData((data) => terminal.write(data))

  const ready = async (): Promise<void> => {
    // The helper re-arms updateCompositionElements on a nested timer, and write() is async.
    await nextEventLoop()
    await nextEventLoop()
    await new Promise<void>((resolve) => terminal.write('', resolve))
  }

  const sample = (): Sample => {
    const line = terminal.buffer.active.getLine(terminal.buffer.active.cursorY)
    return {
      cursorX: terminal.buffer.active.cursorX,
      overlayActive: view.classList.contains('active'),
      overlayCell: Number.parseFloat(view.style.left || '0') / CELL_WIDTH_PX,
      overlayText: (view.textContent ?? '').replaceAll('‎', ''),
      rowText: line?.translateToString(true) ?? ''
    }
  }

  const cell = cellSizeOf(terminal)
  cell.width = CELL_WIDTH_PX
  cell.height = CELL_HEIGHT_PX
  return { events, ready, sample, terminal, textarea }
}

function composition(
  textarea: HTMLTextAreaElement,
  type: 'compositionend' | 'compositionstart' | 'compositionupdate',
  data = ''
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  // happy-dom drops CompositionEventInit.data; Chromium supplies it.
  Object.defineProperty(event, 'data', { value: data })
  textarea.dispatchEvent(event)
}

/**
 * The recorded `beforeinput`/`input` pair that follows every compositionupdate. xterm's
 * `_inputEvent` only acts on `insertText`, so these are inert — they are replayed because
 * the capture contains them, not to drive anything.
 */
function compositionInput(textarea: HTMLTextAreaElement, data: string): void {
  for (const type of ['beforeinput', 'input'] as const) {
    const event = new InputEvent(type, { bubbles: true, data, inputType: 'insertCompositionText' })
    Object.defineProperty(event, 'composed', { value: true })
    Object.defineProperty(event, 'isComposing', { value: true })
    textarea.dispatchEvent(event)
  }
}

function keyEvent(
  textarea: HTMLTextAreaElement,
  type: 'keydown' | 'keyup',
  key: string,
  keyCode: number,
  isComposing: boolean
): void {
  const event = new KeyboardEvent(type, { bubbles: true, key })
  Object.defineProperty(event, 'isComposing', { value: isComposing })
  Object.defineProperty(event, 'keyCode', { value: keyCode })
  textarea.dispatchEvent(event)
}

function setValue(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value
  textarea.setSelectionRange(value.length, value.length)
}

/**
 * The recorded 가나다라 run, key by key, from `ko164.json.events`. `commit` is the syllable
 * MS Korean resolves when the next vowel arrives and the trailing consonant moves on — the
 * boundary where Chromium fires compositionend and compositionstart in one task.
 */
const KOREAN_2SET = [
  { key: 'r', keyCode: 82, preedit: 'ㄱ' },
  { key: 'k', keyCode: 75, preedit: '가' },
  { key: 's', keyCode: 83, preedit: '간' },
  { key: 'k', keyCode: 75, commit: '가', preedit: '나' },
  { key: 'e', keyCode: 69, preedit: '낟' },
  { key: 'k', keyCode: 75, commit: '나', preedit: '다' },
  { key: 'f', keyCode: 70, preedit: '달' },
  { key: 'k', keyCode: 75, commit: '다', preedit: '라' }
] as const

/**
 * The jamo re-clustering the IME actually produced, as a SEPARATE literal from the fixture
 * that drives the rig. Asserting the observed overlay against `stroke.preedit` would move
 * both sides together and pass on a corrupted fixture — this is the independent copy.
 */
const RECORDED_PREEDIT_PROGRESSION = ['ㄱ', '가', '간', '나', '낟', '다', '달', '라'] as const

const ORDINARY_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const

async function typeKorean(
  rig: EchoTerminal
): Promise<{ committed: string; preedit: string; sample: Sample }[]> {
  const samples: { committed: string; preedit: string; sample: Sample }[] = []
  let committed = ''
  let composing = false

  for (const stroke of KOREAN_2SET) {
    // Recorded: the first Process keydown reports isComposing false, every later one true.
    keyEvent(rig.textarea, 'keydown', 'Process', 229, composing)
    if ('commit' in stroke) {
      // The IME resolves the syllable into the textarea, ends, and reopens in one task.
      setValue(rig.textarea, committed + stroke.commit)
      composition(rig.textarea, 'compositionupdate', stroke.commit)
      compositionInput(rig.textarea, stroke.commit)
      composition(rig.textarea, 'compositionend', stroke.commit)
      committed += stroke.commit
      composition(rig.textarea, 'compositionstart')
    } else if (!composing) {
      composition(rig.textarea, 'compositionstart')
      composing = true
    }
    setValue(rig.textarea, committed + stroke.preedit)
    composition(rig.textarea, 'compositionupdate', stroke.preedit)
    compositionInput(rig.textarea, stroke.preedit)
    keyEvent(rig.textarea, 'keyup', 'Process', 229, true)
    keyEvent(rig.textarea, 'keyup', stroke.key, stroke.keyCode, true)
    await rig.ready()
    samples.push({ committed, preedit: stroke.preedit, sample: rig.sample() })
  }
  return samples
}

describe('Korean preedit overlay against committed terminal content', () => {
  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(async () => {
    // updateCompositionElements re-arms itself on a timer; end the composition and let the
    // pending one run before the render service it reads is disposed.
    for (const { textarea } of openTerminals) {
      composition(textarea, 'compositionend')
    }
    await nextEventLoop()
    await nextEventLoop()
    while (openTerminals.length > 0) {
      openTerminals.pop()?.terminal.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('paints each preedit past every syllable the IME has already committed', async () => {
    const rig = openEchoTerminal()
    await new Promise<void>((resolve) => rig.terminal.write(PROMPT, resolve))
    expect(rig.sample()).toMatchObject({ cursorX: PROMPT.length, rowText: PROMPT })

    const samples = await typeKorean(rig)

    // Reported diagnostic, in the columns the capture recorded.
    console.log(
      '[overlap] per-key cursorX/row/overlay:',
      JSON.stringify(
        samples.map(({ committed, sample }) => ({
          committed,
          cursorX: sample.cursorX,
          overlayCell: sample.overlayCell,
          overlayText: sample.overlayText,
          rowText: sample.rowText
        }))
      )
    )

    // The cell each preedit is painted on, against the first cell no committed syllable
    // has a claim on. The right-hand side is counted from the compositionend events the
    // IME fired, so it does not come from the buffer the left-hand side is derived from.
    expect(
      samples.map(({ sample }) => ({
        overlayCell: sample.overlayCell,
        preedit: sample.overlayText
      }))
    ).toEqual(
      samples.map(({ committed, preedit }) => ({
        overlayCell: PROMPT.length + committed.length * CELLS_PER_SYLLABLE,
        // The RECORDED jamo, not the sampled one — comparing sample against sample was
        // tautological and let a corrupted fixture pass.
        preedit
      }))
    )

    // The recorded jamo re-clustering, against an independent literal. The docblock and the
    // matrix c2 cell both cite this progression; without this it was cited and unenforced.
    expect(samples.map(({ sample }) => sample.overlayText)).toEqual([
      ...RECORDED_PREEDIT_PROGRESSION
    ])

    for (const { committed, sample } of samples) {
      // Every committed syllable is on screen, so nothing is queued to land under the overlay.
      expect(sample.rowText).toBe(PROMPT + committed)
      expect(sample.cursorX).toBe(PROMPT.length + committed.length * CELLS_PER_SYLLABLE)
      expect(sample.overlayActive).toBe(true)
    }

    // The recorded v1.4.176 run, column for column. v1.4.164 recorded cursorX
    // 4,4,4,4,4,6,6,8 and `KO> 가나` under a composing 라 — one syllable behind throughout.
    expect(samples.map(({ sample }) => sample.cursorX)).toEqual([4, 4, 4, 6, 6, 8, 8, 10])
    expect(samples.map(({ sample }) => sample.rowText)).toEqual([
      'KO> ',
      'KO> ',
      'KO> ',
      'KO> 가',
      'KO> 가',
      'KO> 가나',
      'KO> 가나',
      'KO> 가나다'
    ])
    expect(samples.at(-1)?.sample).toMatchObject({ overlayCell: 10, overlayText: '라' })
  })

  it('ordinary Latin typing travels no composition path and never lags the cursor', async () => {
    const rig = openEchoTerminal()
    await new Promise<void>((resolve) => rig.terminal.write(PROMPT, resolve))

    const samples: Sample[] = []
    for (const character of ORDINARY_KEYS) {
      const keyCode = character.toUpperCase().charCodeAt(0)
      // Recorded en176: a bare keydown/keyup pair per key, and nothing else.
      keyEvent(rig.textarea, 'keydown', character, keyCode, false)
      keyEvent(rig.textarea, 'keyup', character, keyCode, false)
      await rig.ready()
      samples.push(rig.sample())
    }

    // Self-certification: this arm must not be a Latin *preedit*. Counts are the recorded
    // en176 stats { starts: 0, ends: 0, updates: 0, kc229: 0, keydowns: 8 } and its 16 events.
    expect(rig.events.filter((event) => event.type.startsWith('composition'))).toEqual([])
    expect(rig.events.filter((event) => event.type.endsWith('input'))).toEqual([])
    expect(rig.events.filter((event) => event.isComposing)).toEqual([])
    expect(rig.events.filter((event) => event.keyCode === 229)).toEqual([])
    expect(rig.events).toHaveLength(ORDINARY_KEYS.length * 2)

    for (const [index, sample] of samples.entries()) {
      const typed = ORDINARY_KEYS.slice(0, index + 1).join('')
      expect(sample.rowText).toBe(PROMPT + typed)
      expect(sample.cursorX).toBe(PROMPT.length + typed.length)
      expect(sample.overlayActive).toBe(false)
    }
    // Recorded en176 end state.
    expect(samples.at(-1)).toMatchObject({ cursorX: 12, rowText: 'KO> abcdefgh' })
  })

  it('the Korean arm does travel the composition path the Latin arm does not', async () => {
    const rig = openEchoTerminal()
    await new Promise<void>((resolve) => rig.terminal.write(PROMPT, resolve))
    await typeKorean(rig)

    // Recorded ko164/ko176 stats: starts 4, ends 3, updates 11; ko164 keydowns 8, kc229 16
    // (a Process keydown and a Process keyup per key), and 64 events in total.
    const countOf = (type: string): number => rig.events.filter((e) => e.type === type).length
    expect(countOf('compositionstart')).toBe(4)
    expect(countOf('compositionend')).toBe(3)
    expect(countOf('compositionupdate')).toBe(11)
    expect(countOf('keydown')).toBe(8)
    expect(rig.events.filter((event) => event.keyCode === 229)).toHaveLength(16)
    expect(rig.events).toHaveLength(64)
    // The paired half of the Latin arm's self-certification: isComposing is not inert here.
    expect(rig.events.filter((event) => event.isComposing).length).toBeGreaterThan(0)

    // The recorded per-key ordering, from `ko164.json.events`.
    expect(rig.events.map((event) => event.type).slice(0, 7)).toEqual([
      'keydown',
      'compositionstart',
      'compositionupdate',
      'beforeinput',
      'input',
      'keyup',
      'keyup'
    ])
    // Syllable boundary: the previous syllable ends and the next opens in the same task.
    expect(rig.events.map((event) => event.type).slice(19, 30)).toEqual([
      'keydown',
      'compositionupdate',
      'beforeinput',
      'input',
      'compositionend',
      'compositionstart',
      'compositionupdate',
      'beforeinput',
      'input',
      'keyup',
      'keyup'
    ])
  })
})
