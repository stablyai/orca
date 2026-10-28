// @vitest-environment happy-dom
// Replay real IBus/fcitx5 Hangul traces against xterm and assert whole PTY output across five repetitions to catch drops, duplicates and reordering beyond the first commit.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fcitx5Trace from './__fixtures__/fcitx5-hangul-mixed-ascii-terminal-trace.json'
import ibusTrace from './__fixtures__/ibus-hangul-mixed-ascii-terminal-trace.json'
import {
  installTypingLatencyInputEvents,
  type TypingInputSignal
} from '@/lib/typing-latency/input-events'

type RecordedEvent = {
  type: string
  inputType?: string
  data?: string
  key?: string
  code?: string
  keyCode?: number
  isComposing?: boolean
  value?: string
  selectionStart?: number
  selectionEnd?: number
}

type RecordedTrace = {
  recordedFrom: string
  inputFramework: string
  engine: string | null
  repetitions: number
  expectedLines: string[]
  receivedBytes: string[]
  dom: RecordedEvent[]
  onData: string[]
}

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(): { emitted: string[]; terminal: Terminal; textarea: HTMLTextAreaElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea
  if (!textarea) {
    throw new Error('xterm helper textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, terminal, textarea }
}

function buildEvent(recorded: RecordedEvent): Event {
  if (recorded.type === 'keydown' || recorded.type === 'keyup' || recorded.type === 'keypress') {
    const keyboard = new KeyboardEvent(recorded.type, {
      key: recorded.key,
      code: recorded.code,
      isComposing: recorded.isComposing,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(keyboard, 'keyCode', { value: recorded.keyCode })
    return keyboard
  }
  if (recorded.type === 'input' || recorded.type === 'beforeinput') {
    const input = new InputEvent(recorded.type, {
      isComposing: recorded.isComposing,
      bubbles: true
    })
    // happy-dom drops these three from InputEventInit; Chromium supplies all of them.
    Object.defineProperty(input, 'inputType', { value: recorded.inputType ?? '' })
    Object.defineProperty(input, 'data', { value: recorded.data ?? null })
    Object.defineProperty(input, 'composed', { value: true })
    return input
  }
  const composition = new CompositionEvent(recorded.type, { bubbles: true })
  Object.defineProperty(composition, 'data', { value: recorded.data ?? '' })
  return composition
}

/** Each capture snapshots the textarea as the handler saw it, so restore that before dispatching. */
function replayEvent(textarea: HTMLTextAreaElement, recorded: RecordedEvent): void {
  if (recorded.value !== undefined) {
    textarea.value = recorded.value
  }
  if (recorded.selectionStart !== undefined && recorded.selectionEnd !== undefined) {
    textarea.setSelectionRange(recorded.selectionStart, recorded.selectionEnd)
  }
  textarea.dispatchEvent(buildEvent(recorded))
}

type PreeditSample = { data: string; shown: boolean }

async function replayTrace(trace: RecordedTrace): Promise<{
  stream: string
  preedits: PreeditSample[]
  highlights: string[]
  inputSignals: TypingInputSignal[]
}> {
  const { emitted, terminal, textarea } = openTerminal()
  const preedits: PreeditSample[] = []
  const highlights: string[] = []
  const inputSignals: TypingInputSignal[] = []
  const detachInputEvents = installTypingLatencyInputEvents(window, (signal) => {
    inputSignals.push(signal)
  })
  try {
    for (const recorded of trace.dom) {
      // Physical keys start separate tasks; composition/input derived from one key stay in its task for deferred commit.
      if (recorded.type === 'keydown' || recorded.type === 'keyup') {
        await nextEventLoop()
      }
      replayEvent(textarea, recorded)
      if (terminal.element?.querySelector('.xterm-composition-preedit-selected')) {
        highlights.push(recorded.type)
      }
      if (recorded.type === 'compositionupdate' && recorded.data) {
        const view = terminal.element?.querySelector('.composition-view')
        preedits.push({ data: recorded.data, shown: view?.classList.contains('active') === true })
      }
    }
    // Two turns: the commit's deferred send, then the late-native-commit window it opens.
    await nextEventLoop()
    await nextEventLoop()
    return { stream: emitted.join(''), preedits, highlights, inputSignals }
  } finally {
    detachInputEvents()
    terminal.dispose()
  }
}

describe.each([
  ['IBus', ibusTrace as RecordedTrace],
  ['fcitx5', fcitx5Trace as RecordedTrace]
])('%s Hangul commits interleaved with ASCII', (_framework, trace) => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('reproduces the recorded onData stream exactly', async () => {
    expect((await replayTrace(trace)).stream).toBe(trace.onData.join(''))
  })

  it('sends each committed syllable once per repetition', async () => {
    const { stream } = await replayTrace(trace)
    expect(stream.match(/한/g)).toHaveLength(trace.repetitions)
    expect(stream.match(/글/g)).toHaveLength(trace.repetitions)
    // The ASCII typed between the two commits is the part a mis-scoped commit swallows.
    expect(stream.match(/abc/g)).toHaveLength(trace.repetitions)
  })

  it('reports each reconciled commit to the typing diagnostic', async () => {
    const { inputSignals } = await replayTrace(trace)
    const expectedCommits = trace.expectedLines.flatMap((line) => [line.at(0), line.at(-1)])
    const commitSignals = inputSignals
      .filter((signal) => signal.source === 'ime')
      .map((signal) => signal.text)

    if (trace.inputFramework === 'ibus') {
      const rawEndData = trace.dom
        .filter((recorded) => recorded.type === 'compositionend')
        .map((recorded) => recorded.data ?? '')
      expect(rawEndData.length).toBeGreaterThan(0)
      expect(rawEndData.every((data) => data === '')).toBe(true)
    }
    expect(commitSignals).toEqual(expectedCommits)
  })

  it('matches the bytes the PTY received on the recorded run', async () => {
    const { stream } = await replayTrace(trace)
    // The tty turned each CR into LF, so compare against the recorded lines plus that conversion.
    const lines = Buffer.from(trace.receivedBytes.join(''), 'hex').toString('utf8')
    expect(stream.replaceAll('\r', '\n')).toBe(lines)
  })

  // Output bytes alone cannot prove visible preedit; assert the overlay too so composing cannot pass while hidden.
  it('keeps the preedit visible for every recorded composition update', async () => {
    const { preedits } = await replayTrace(trace)
    expect(preedits.length).toBeGreaterThan(0)
    expect(preedits.filter((sample) => !sample.shown)).toEqual([])
  })

  // Why: Hangul IMEs keep the syllable they are replacing selected until the input event collapses
  // it, so reading the selection any earlier flashes every syllable as a converted clause.
  it('does not highlight the syllable the IME is replacing', async () => {
    expect((await replayTrace(trace)).highlights).toEqual([])
  })
})
