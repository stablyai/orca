// @vitest-environment happy-dom
/** Replay recorded Hangul commits followed by Chromium-shaped digit input; only a live Hanja composition owns candidate digits, so a post-commit digit must reach the PTY (#15299). */
import { describe, expect, it } from 'vitest'
import fcitx5Trace from './__fixtures__/fcitx5-hangul-mixed-ascii-terminal-trace.json'
import ibusTrace from './__fixtures__/ibus-hangul-mixed-ascii-terminal-trace.json'
import { installTerminalImeCompositionTracker } from './terminal-ime-composition-tracker'
import {
  buildRecordedDomEvent,
  replayThroughLinuxPane,
  useLinuxPaneTestEnvironment,
  type RecordedDomEvent
} from './terminal-ime-linux-pane-replay-fixture'
import {
  shouldPreventDefaultTerminalImeCandidateKey,
  shouldSuppressTerminalImeKeyboardEvent
} from './xterm-bypass-policy'
import { event } from './xterm-bypass-event-fixture'

type RecordedTrace = { dom: RecordedDomEvent[] }

const TRACES: [string, RecordedTrace][] = [
  ['IBus', ibusTrace],
  ['fcitx5', fcitx5Trace]
]

const DIGIT_KEYSTROKE: RecordedDomEvent[] = [
  { type: 'keydown', key: '1', code: 'Digit1', keyCode: 49 },
  { type: 'keypress', key: '1', code: 'Digit1', keyCode: 49, charCode: 49 },
  { type: 'beforeinput', inputType: 'insertText', data: '1' },
  { type: 'input', inputType: 'insertText', data: '1' },
  { type: 'keyup', key: '1', code: 'Digit1', keyCode: 49 }
]

/** The recorded events through the first syllable's commit, before the ASCII that follows it. */
function firstSyllableCommit(trace: RecordedTrace): RecordedDomEvent[] {
  const firstAscii = trace.dom.findIndex(
    (recorded) => recorded.type === 'keydown' && recorded.key === 'a'
  )
  return trace.dom.slice(0, firstAscii)
}

describe('a digit typed after a committed Hangul syllable on Linux', () => {
  useLinuxPaneTestEnvironment()

  it.each(TRACES)('reaches the pty after a %s commit', async (_framework, trace) => {
    const { emitted, preventedKeydownCodes } = await replayThroughLinuxPane([
      ...firstSyllableCommit(trace),
      ...DIGIT_KEYSTROKE
    ])
    expect(emitted).toBe('한1')
    expect(preventedKeydownCodes).not.toContain('Digit1')
  })
})

describe('the Linux IME policy around a Hangul commit', () => {
  const digitKeydown = event({ type: 'keydown', key: '1', code: 'Digit1', keyCode: 49 })

  function linuxOptions(tracker: ReturnType<typeof installTerminalImeCompositionTracker>) {
    return {
      compositionActive: tracker.isActive(),
      candidateKeyGuardActive: tracker.isCandidateKeyGuardActive(),
      pendingCandidateKeyReleaseActive: false,
      isMac: false,
      isLinux: true
    }
  }

  function replayInto(element: HTMLElement, events: RecordedDomEvent[]): void {
    for (const recorded of events) {
      element.dispatchEvent(buildRecordedDomEvent(recorded))
    }
  }

  it.each(TRACES)(
    'leaves the digit alone once a %s syllable has committed',
    (_framework, trace) => {
      const element = document.createElement('div')
      const tracker = installTerminalImeCompositionTracker(element)
      replayInto(element, firstSyllableCommit(trace))

      expect(shouldSuppressTerminalImeKeyboardEvent(digitKeydown, linuxOptions(tracker))).toBe(
        false
      )
      expect(shouldPreventDefaultTerminalImeCandidateKey(digitKeydown, linuxOptions(tracker))).toBe(
        false
      )
      tracker.dispose()
    }
  )

  it('keeps the digit IME-owned while the Hangul preedit is still live', () => {
    const element = document.createElement('div')
    const tracker = installTerminalImeCompositionTracker(element)
    const preeditOpen = ibusTrace.dom.findIndex(
      (recorded) => recorded.type === 'compositionupdate' && recorded.data === '한'
    )
    replayInto(element, ibusTrace.dom.slice(0, preeditOpen + 1))

    // ibus-hangul's Hanja conversion puts a numbered lookup table over a live preedit.
    expect(shouldSuppressTerminalImeKeyboardEvent(digitKeydown, linuxOptions(tracker))).toBe(true)
    tracker.dispose()
  })
})
