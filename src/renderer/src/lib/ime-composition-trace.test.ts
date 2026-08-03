// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  createImeTraceInputEvent,
  createImeTraceKeyboardEvent,
  createImeTraceTextarea,
  EMPTY_IME_TRACE_STATE,
  extractImeCommitsFromTrace,
  interpretImeCommits,
  replayImeCompositionTrace
} from './ime-composition-trace.test-fixtures'
import type { ImeTraceKeyEvent } from './ime-composition-trace.test-fixtures'
import { isImeCompositionKeyDown } from './ime-composition-keyboard-event'
import {
  CANDIDATE_ESCAPE_DISMISSAL_TRACE,
  IBUS_HANGUL_MIXED_LATIN_TRACE,
  IBUS_HANGUL_RETAINED_COMMIT_TRACE,
  IBUS_HANGUL_TERMINAL_JAMO_COMMIT_TRACE,
  IME_COMPOSITION_TRACES
} from './ime-recorded-composition-traces.test-fixtures'

const KEY_EVENT_WITHOUT_REPEAT: ImeTraceKeyEvent = {
  code: 'KeyE',
  isComposing: false,
  key: 'e',
  keyCode: 69,
  state: EMPTY_IME_TRACE_STATE,
  type: 'keydown'
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('recorded composition traces', () => {
  it.each(IME_COMPOSITION_TRACES.map((trace) => [trace.name, trace] as const))(
    '%s replays to its recorded final state',
    async (_name, trace) => {
      const textarea = createImeTraceTextarea(document)

      const replay = await replayImeCompositionTrace(textarea, trace)

      expect(replay.violations).toEqual([])
      expect(replay.dispatched).toHaveLength(trace.events.length)
      // Not asserted here: the textarea's final contents. The harness stamps each
      // event's recorded state in before dispatching it, so after the last event the
      // textarea necessarily holds `trace.final` no matter what any listener did.
      // The real check is the independent interpretation below.
    }
  )

  it.each(IME_COMPOSITION_TRACES.map((trace) => [trace.name, trace] as const))(
    '%s reaches its final text from event data alone',
    (_name, trace) => {
      // Derived from the event stream, never from the stamped buffer, so this fails
      // when a trace's declared data does not actually add up to what it claims.
      const commits = extractImeCommitsFromTrace(trace)

      expect(commits.map((commit) => commit.text).join('')).toBe(trace.committed)
      expect(interpretImeCommits(trace.initial, commits)).toEqual(trace.final)
    }
  )

  it('reports the wrong text when commits are appended instead of replaced', () => {
    // Guards the interpreter itself: Hangul commits carry replacePrevCharCnt: 1 on
    // most events, and an appending implementation would score as correct without this.
    const initial = { selectionEnd: 0, selectionStart: 0, value: '' }
    const replacing = [{ text: 'ㅇ' }, { replacePrevCharCnt: 1, text: '아' }]

    expect(interpretImeCommits(initial, replacing).value).toBe('아')
    expect(interpretImeCommits(initial, [{ text: 'ㅇ' }, { text: '아' }]).value).toBe('ㅇ아')
  })

  it('classifies the recorded Enter that ibus-hangul consumed to commit', () => {
    // Ground truth for what a real engine actually sends, which the derived traces were
    // only guessing at: ibus-hangul sets all three markers on the committing Enter, so
    // any one of them would catch it here. The union still earns its keep — the Windows
    // and Safari cases in ime-composition-keyboard-event.test.ts carry only some of them.
    const committingEnter = IBUS_HANGUL_TERMINAL_JAMO_COMMIT_TRACE.events.find(
      (event) => event.type === 'keydown' && event.code === 'Enter'
    )

    expect(committingEnter).toMatchObject({ isComposing: true, key: 'Process', keyCode: 229 })
    expect(isImeCompositionKeyDown(committingEnter as ImeTraceKeyEvent)).toBe(true)
    // The paired negative: an otherwise identical Enter with no IME marker must submit.
    expect(isImeCompositionKeyDown({ isComposing: false, key: 'Enter', keyCode: 13 })).toBe(false)
  })

  it('classifies the Escape that dismisses a candidate window as IME-owned', () => {
    // The premise the Escape exemption rests on, pinned so a real recording can
    // contradict it: an Escape the IME owns is marked, so the exemption never sees it.
    // Derived, not recorded — see the trace's origin.
    const dismissal = CANDIDATE_ESCAPE_DISMISSAL_TRACE.events.find(
      (event) => event.type === 'keydown' && event.key === 'Escape'
    )

    expect(dismissal).toMatchObject({ isComposing: true, keyCode: 27 })
    expect(isImeCompositionKeyDown(dismissal as ImeTraceKeyEvent)).toBe(true)
    // The paired negative: the same Escape unmarked is the drift case, and must pass.
    expect(isImeCompositionKeyDown({ isComposing: false, key: 'Escape', keyCode: 27 })).toBe(false)
  })

  it('derives no commit from the plain ASCII typed between two compositions', () => {
    // 'abc' goes straight to the PTY in the recorded trace and never becomes a commit.
    const commits = extractImeCommitsFromTrace(IBUS_HANGUL_TERMINAL_JAMO_COMMIT_TRACE)

    expect(commits.map((commit) => commit.text)).toEqual(['한', '글'])
  })

  it('survives the deleteContentBackward that ibus-hangul emits before committing', () => {
    // A buffer-diffing implementation loses the character here: the engine tears the
    // preedit down first, so the buffer is shorter immediately before the commit.
    const events = IBUS_HANGUL_TERMINAL_JAMO_COMMIT_TRACE.events
    const teardown = events.findIndex(
      (event) => event.type === 'input' && event.inputType === 'deleteContentBackward'
    )

    expect(teardown).toBeGreaterThan(-1)
    expect(events[teardown + 1]?.type).toBe('compositionend')
    expect(
      interpretImeCommits(
        IBUS_HANGUL_TERMINAL_JAMO_COMMIT_TRACE.initial,
        extractImeCommitsFromTrace(IBUS_HANGUL_TERMINAL_JAMO_COMMIT_TRACE)
      )
    ).toEqual(IBUS_HANGUL_TERMINAL_JAMO_COMMIT_TRACE.final)
  })

  it('keeps a retained commit that ordinary typing follows', () => {
    // The de-dup must not let a later insertText from plain typing cancel a
    // compositionend that was the only carrier of its commit.
    const retained = IME_COMPOSITION_TRACES.find((trace) => trace.name.includes('retained commit'))

    expect(extractImeCommitsFromTrace(retained!).map((c) => c.text)).toEqual(['테', '스'])
  })

  it.each(IME_COMPOSITION_TRACES.map((trace) => [trace.name, trace] as const))(
    '%s declares a non-empty origin and a provenance',
    (_name, trace) => {
      expect(trace.origin.length).toBeGreaterThan(0)
      expect(['derived', 'recorded']).toContain(trace.provenance)
    }
  )

  it('marks every event with the buffer state observed at that instant', () => {
    for (const trace of IME_COMPOSITION_TRACES) {
      for (const event of trace.events) {
        expect(event.state.selectionStart).toBeLessThanOrEqual(event.state.value.length)
        expect(event.state.selectionEnd).toBeLessThanOrEqual(event.state.value.length)
      }
    }
  })
})

describe('replayImeCompositionTrace', () => {
  it('stamps the recorded buffer before each event rather than simulating it', async () => {
    const textarea = createImeTraceTextarea(document)
    const seen: string[] = []
    textarea.addEventListener('compositionupdate', () => seen.push(textarea.value))

    await replayImeCompositionTrace(textarea, IBUS_HANGUL_RETAINED_COMMIT_TRACE)

    // The engine reports the pre-edit buffer on compositionupdate, not the composed text.
    expect(seen).toEqual(['', '테'])
  })

  it('reports a listener that writes to the buffer during compositionstart', async () => {
    const textarea = createImeTraceTextarea(document)
    textarea.addEventListener('compositionstart', () => {
      // Clearing here makes real browsers skip compositionend entirely.
      textarea.value = ''
    })

    const replay = await replayImeCompositionTrace(textarea, IBUS_HANGUL_MIXED_LATIN_TRACE)

    expect(replay.violations).toEqual([
      { eventType: 'compositionstart', reason: 'wrote "" to the target during compositionstart' }
    ])
  })

  it('yields between events so async handlers observe the recorded ordering', async () => {
    const textarea = createImeTraceTextarea(document)
    const order: string[] = []

    await replayImeCompositionTrace(textarea, IBUS_HANGUL_RETAINED_COMMIT_TRACE, {
      onEvent: (event) => order.push(event.type),
      yieldBetweenEvents: () => Promise.resolve()
    })

    expect(order.slice(0, 4)).toEqual([
      'compositionstart',
      'keydown',
      'compositionupdate',
      'beforeinput'
    ])
  })

  it('preserves the legacy keyCode engines report for IME-consumed keys', async () => {
    const textarea = createImeTraceTextarea(document)
    const processKeyCodes: number[] = []
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Process') {
        processKeyCodes.push(event.keyCode)
      }
    })

    await replayImeCompositionTrace(textarea, IBUS_HANGUL_RETAINED_COMMIT_TRACE)

    expect(processKeyCodes).toEqual([229, 229])
  })

  it('preserves isComposing on the keystrokes the IME owns', async () => {
    const textarea = createImeTraceTextarea(document)
    const composing: boolean[] = []
    textarea.addEventListener('keydown', (event) => composing.push(event.isComposing))

    await replayImeCompositionTrace(textarea, IBUS_HANGUL_RETAINED_COMMIT_TRACE)

    // Process keys are composing; the interleaved 'a' and the trailing Enter are not.
    expect(composing).toEqual([true, false, true, false])
  })

  it("replays Safari's undefined isComposing as undefined rather than false", () => {
    // The whole reason the field is `boolean | undefined`: code that branches on
    // `=== undefined` must see the two apart, and the constructor coerces.
    const safari = createImeTraceInputEvent({
      data: 'a',
      inputType: 'insertText',
      isComposing: undefined,
      state: EMPTY_IME_TRACE_STATE,
      type: 'input'
    })
    const chromium = createImeTraceInputEvent({
      data: 'a',
      inputType: 'insertText',
      isComposing: false,
      state: EMPTY_IME_TRACE_STATE,
      type: 'input'
    })

    expect(safari.isComposing).toBeUndefined()
    expect(chromium.isComposing).toBe(false)
  })

  it('replays the repeat flag macOS press-and-hold is distinguished by', () => {
    const held = createImeTraceKeyboardEvent({
      code: 'KeyE',
      isComposing: false,
      key: 'e',
      keyCode: 69,
      repeat: true,
      state: EMPTY_IME_TRACE_STATE,
      type: 'keydown'
    })

    expect(held.repeat).toBe(true)
    expect(createImeTraceKeyboardEvent(KEY_EVENT_WITHOUT_REPEAT).repeat).toBe(false)
  })

  it('replays a backward selection so a preedit range is not flattened to a caret', async () => {
    const textarea = createImeTraceTextarea(document)
    const directions: (string | null)[] = []
    textarea.addEventListener('keydown', () => directions.push(textarea.selectionDirection))

    await replayImeCompositionTrace(textarea, {
      ...IBUS_HANGUL_RETAINED_COMMIT_TRACE,
      events: [
        {
          code: 'KeyA',
          isComposing: false,
          key: 'a',
          keyCode: 65,
          state: {
            selectionDirection: 'backward',
            selectionEnd: 2,
            selectionStart: 0,
            value: 'ab'
          },
          type: 'keydown'
        }
      ]
    })

    expect(directions).toEqual(['backward'])
  })
})
