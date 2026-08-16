// @vitest-environment happy-dom
// Replays two recorded Linux native-IME captures against a real xterm Terminal and asserts the
// recorded onData verbatim. Both were taken against a live ibus-daemon / fcitx5 on Xvfb :99 with
// the Hangul engine, typing 한abc글 then Enter five times, and both read `ed959c616263eab8800a`
// off the PTY on every repetition.
//
// The gesture is the one Linux IME users report on: commit a syllable, type ASCII with the IME
// still selected, commit another. Its two failure modes are a syllable lost and a syllable sent
// twice, so the whole trace is asserted as one string rather than per-event — a drop, a repeat and
// a reorder each move it.
//
// This is offline coverage for what only tests/e2e/terminal-linux-ime-native.spec.ts had, and that
// spec needs a Linux host with a real input framework. Five repetitions are kept because "exactly
// once" is a claim about the steady state, not about the first commit.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fcitx5Trace from './__fixtures__/fcitx5-hangul-mixed-ascii-terminal-trace.json'
import ibusTrace from './__fixtures__/ibus-hangul-mixed-ascii-terminal-trace.json'

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

async function replayTrace(
  trace: RecordedTrace
): Promise<{ stream: string; preedits: PreeditSample[] }> {
  const { emitted, terminal, textarea } = openTerminal()
  const preedits: PreeditSample[] = []
  for (const recorded of trace.dom) {
    // Keys were driven 20 ms apart, so every physical key event began its own task; the composition
    // and input events the IME derived from one key stay in that key's task, which is what lets
    // xterm's deferred commit see them.
    if (recorded.type === 'keydown' || recorded.type === 'keyup') {
      await nextEventLoop()
    }
    replayEvent(textarea, recorded)
    if (recorded.type === 'compositionupdate' && recorded.data) {
      const view = terminal.element?.querySelector('.composition-view')
      preedits.push({ data: recorded.data, shown: view?.classList.contains('active') === true })
    }
  }
  // Two turns: the commit's deferred send, then the late-native-commit window it opens.
  await nextEventLoop()
  await nextEventLoop()
  terminal.dispose()
  return { stream: emitted.join(''), preedits }
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

  it('matches the bytes the PTY received on the recorded run', async () => {
    const { stream } = await replayTrace(trace)
    // The tty turned each CR into LF, so compare against the recorded lines plus that conversion.
    const lines = Buffer.from(trace.receivedBytes.join(''), 'hex').toString('utf8')
    expect(stream.replaceAll('\r', '\n')).toBe(lines)
  })

  // Why: bytes reaching the PTY say nothing about whether the user could SEE what they were
  // composing. A preedit written into a hidden overlay types blind and still passes every
  // onData assertion above, which is how that class of defect has shipped before.
  it('keeps the preedit visible for every recorded composition update', async () => {
    const { preedits } = await replayTrace(trace)
    expect(preedits.length).toBeGreaterThan(0)
    expect(preedits.filter((sample) => !sample.shown)).toEqual([])
  })
})
