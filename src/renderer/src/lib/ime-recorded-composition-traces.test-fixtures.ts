// Composition traces used across the IME suites. See the IME rules in AGENTS.md.
//
// Adding a trace: prefer capturing one from a real engine and mark it `recorded`.
// A `derived` trace pins current behavior but proves nothing about the engine.

import type {
  ImeCompositionTrace,
  ImeTraceEvent,
  ImeTraceTargetState
} from './ime-composition-trace.test-fixtures'
import { IBUS_HANGUL_TERMINAL_JAMO_COMMIT_TRACE } from './ime-recorded-ibus-hangul-trace.test-fixtures'

export { IBUS_HANGUL_TERMINAL_JAMO_COMMIT_TRACE }

/** Caret collapsed at the end of `value`, which is where every trace below sits. */
function caretAtEnd(value: string): ImeTraceTargetState {
  return { selectionEnd: value.length, selectionStart: value.length, value }
}

function compositionStart(value: string): ImeTraceEvent {
  return { data: '', state: caretAtEnd(value), type: 'compositionstart' }
}

function compositionUpdate(value: string, data: string): ImeTraceEvent {
  return { data, state: caretAtEnd(value), type: 'compositionupdate' }
}

function compositionEnd(value: string, data: string): ImeTraceEvent {
  return { data, state: caretAtEnd(value), type: 'compositionend' }
}

function processKeydown(value: string, code: string): ImeTraceEvent {
  return {
    code,
    isComposing: true,
    key: 'Process',
    keyCode: 229,
    state: caretAtEnd(value),
    type: 'keydown'
  }
}

function plainKeydown(value: string, key: string, code: string, keyCode: number): ImeTraceEvent {
  return { code, isComposing: false, key, keyCode, state: caretAtEnd(value), type: 'keydown' }
}

/** `beforeinput` carries the pre-edit buffer; `input` carries the post-edit buffer. */
function editPair(before: string, after: string, inputType: string, data: string): ImeTraceEvent[] {
  const isComposing = inputType === 'insertCompositionText'
  return [
    { data, inputType, isComposing, state: caretAtEnd(before), type: 'beforeinput' },
    { data, inputType, isComposing, state: caretAtEnd(after), type: 'input' }
  ]
}

/**
 * Hangul syllables committed without a trailing `insertText` — the composed text is
 * retained in the buffer from the last `insertCompositionText`. A surface that waits
 * for `insertText` before committing drops both syllables.
 */
export const IBUS_HANGUL_RETAINED_COMMIT_TRACE: ImeCompositionTrace = {
  committed: '테스',
  env: { browser: 'chromium', engine: 'ibus-hangul', platform: 'linux' },
  events: [
    compositionStart(''),
    processKeydown('', 'KeyG'),
    compositionUpdate('', '테'),
    ...editPair('', '테', 'insertCompositionText', '테'),
    compositionEnd('테', '테'),
    plainKeydown('테', 'a', 'KeyA', 65),
    processKeydown('테', 'KeyR'),
    compositionStart('테'),
    compositionUpdate('테', '스'),
    ...editPair('테', '테스', 'insertCompositionText', '스'),
    compositionEnd('테스', '스'),
    plainKeydown('테스', 'Enter', 'Enter', 13)
  ],
  final: caretAtEnd('테스'),
  initial: caretAtEnd(''),
  name: 'Linux - Chromium - ibus-hangul - retained commit',
  origin:
    'Transcribed from the synthetic sequence terminal-ime-e2e replays in CI ' +
    '(tests/e2e/terminal-ime-observed-event-sequences.ts), which hand-dispatches these ' +
    'events rather than capturing them. Selection offsets are reconstructed as a collapsed ' +
    'caret at end-of-buffer. To promote this to `recorded`, capture it through ' +
    'tests/e2e/terminal-ime-boundary-probe.ts, which reads true offsets off a live ' +
    'ibus-hangul session.',
  provenance: 'derived'
}

/**
 * Hangul, then Latin typed directly, then Hangul again. Pins that a surface which
 * defers on composition does not also defer the interleaved plain keystrokes.
 */
export const IBUS_HANGUL_MIXED_LATIN_TRACE: ImeCompositionTrace = {
  committed: '한abc글',
  env: { browser: 'chromium', engine: 'ibus-hangul', platform: 'linux' },
  events: [
    compositionStart(''),
    processKeydown('', 'KeyG'),
    compositionUpdate('', '한'),
    ...editPair('', '한', 'insertCompositionText', '한'),
    compositionUpdate('한', ''),
    ...editPair('한', '', 'deleteContentBackward', ''),
    compositionEnd('', ''),
    ...editPair('', '한', 'insertText', '한'),
    plainKeydown('한', 'a', 'KeyA', 65),
    ...editPair('한', '한a', 'insertText', 'a'),
    plainKeydown('한a', 'b', 'KeyB', 66),
    ...editPair('한a', '한ab', 'insertText', 'b'),
    plainKeydown('한ab', 'c', 'KeyC', 67),
    ...editPair('한ab', '한abc', 'insertText', 'c'),
    compositionStart('한abc'),
    processKeydown('한abc', 'KeyG'),
    compositionUpdate('한abc', '글'),
    ...editPair('한abc', '한abc글', 'insertCompositionText', '글'),
    compositionUpdate('한abc글', ''),
    ...editPair('한abc글', '한abc', 'deleteContentBackward', ''),
    compositionEnd('한abc', ''),
    ...editPair('한abc', '한abc글', 'insertText', '글'),
    plainKeydown('한abc글', 'Enter', 'Enter', 13)
  ],
  final: caretAtEnd('한abc글'),
  initial: caretAtEnd(''),
  name: 'Linux - Chromium - ibus-hangul - mixed with Latin',
  origin:
    'Transcribed from the synthetic sequence terminal-ime-e2e replays in CI ' +
    '(tests/e2e/terminal-ime-observed-event-sequences.ts), which hand-dispatches these ' +
    'events rather than capturing them. Note the commit arrives as a deleteContentBackward ' +
    'that empties the preedit followed by insertText — a length-only diff sees the delete ' +
    'and sends a backspace. Promote via tests/e2e/terminal-ime-boundary-probe.ts.',
  provenance: 'derived'
}

/**
 * Vietnamese Telex: `a` `a` composes `â`, then Backspace decomposes it back to `a`.
 * Backspace is IME-owned here — forwarding it to the PTY deletes real shell input.
 */
export const TELEX_BACKSPACE_MID_COMPOSITION_TRACE: ImeCompositionTrace = {
  committed: 'a',
  env: { browser: 'chromium', engine: 'Telex', platform: 'darwin' },
  events: [
    compositionStart(''),
    processKeydown('', 'KeyA'),
    compositionUpdate('', 'a'),
    ...editPair('', 'a', 'insertCompositionText', 'a'),
    processKeydown('a', 'KeyA'),
    compositionUpdate('a', 'â'),
    ...editPair('a', 'â', 'insertCompositionText', 'â'),
    {
      code: 'Backspace',
      isComposing: true,
      key: 'Backspace',
      keyCode: 8,
      state: caretAtEnd('â'),
      type: 'keydown'
    },
    compositionUpdate('â', 'a'),
    ...editPair('â', 'a', 'insertCompositionText', 'a'),
    compositionEnd('a', 'a')
  ],
  final: caretAtEnd('a'),
  initial: caretAtEnd(''),
  name: 'macOS - Chromium - Telex - Backspace decomposes mid-composition',
  origin:
    'Derived from the symptom in orca#6494 / #6698 / #6905: Backspace during a Telex ' +
    'composition reaches the PTY instead of the IME. Not hardware-recorded — the ordering ' +
    'follows the documented compositionupdate-per-keystroke contract.',
  provenance: 'derived'
}

/**
 * Arrow keys select a candidate; they must not reach the shell's readline.
 */
export const CANDIDATE_ARROW_NAVIGATION_TRACE: ImeCompositionTrace = {
  committed: '中',
  env: { browser: 'chromium', engine: 'Pinyin', platform: 'darwin' },
  events: [
    compositionStart(''),
    processKeydown('', 'KeyZ'),
    compositionUpdate('', 'zhong'),
    ...editPair('', 'zhong', 'insertCompositionText', 'zhong'),
    {
      code: 'ArrowDown',
      isComposing: true,
      key: 'ArrowDown',
      keyCode: 40,
      state: caretAtEnd('zhong'),
      type: 'keydown'
    },
    {
      code: 'ArrowUp',
      isComposing: true,
      key: 'ArrowUp',
      keyCode: 38,
      state: caretAtEnd('zhong'),
      type: 'keydown'
    },
    compositionUpdate('zhong', '中'),
    ...editPair('zhong', '中', 'insertCompositionText', '中'),
    compositionEnd('中', '中')
  ],
  final: caretAtEnd('中'),
  initial: caretAtEnd(''),
  name: 'macOS - Chromium - Pinyin - arrow candidate navigation',
  origin:
    'Derived from orca#9803: arrow keys during composition move the shell cursor. ' +
    'Not hardware-recorded.',
  provenance: 'derived'
}

/**
 * Escape dismisses the candidate window and commits nothing.
 *
 * This trace exists to make one assumption falsifiable rather than leave it in prose:
 * `isImeCompositionKeyDown` exempts Escape from the derived composition flag, and that
 * is only safe if an Escape the IME owns arrives marked. Nothing hardware-recorded
 * shows that yet. Replace this with a recording (`pnpm ime:record`) and the exemption
 * is either proven or contradicted here first.
 */
export const CANDIDATE_ESCAPE_DISMISSAL_TRACE: ImeCompositionTrace = {
  committed: '',
  env: { browser: 'chromium', engine: 'Pinyin', platform: 'darwin' },
  events: [
    compositionStart(''),
    processKeydown('', 'KeyZ'),
    compositionUpdate('', 'zhong'),
    ...editPair('', 'zhong', 'insertCompositionText', 'zhong'),
    {
      code: 'Escape',
      isComposing: true,
      key: 'Escape',
      keyCode: 27,
      state: caretAtEnd('zhong'),
      type: 'keydown'
    },
    // The engine tears the preedit down itself; the buffer is empty before the end.
    ...editPair('zhong', '', 'insertCompositionText', ''),
    compositionEnd('', '')
  ],
  final: caretAtEnd(''),
  initial: caretAtEnd(''),
  name: 'macOS - Chromium - Pinyin - Escape dismisses the candidate window',
  origin:
    'Derived from the Escape exemption in ime-composition-keyboard-event.ts, not ' +
    'hardware-recorded. Promote with config/scripts/record-ime-trace.mjs on macOS or ' +
    'Windows: compose, open the candidate window, press Escape.',
  provenance: 'derived'
}

export const IME_COMPOSITION_TRACES: readonly ImeCompositionTrace[] = [
  IBUS_HANGUL_TERMINAL_JAMO_COMMIT_TRACE,
  IBUS_HANGUL_RETAINED_COMMIT_TRACE,
  IBUS_HANGUL_MIXED_LATIN_TRACE,
  TELEX_BACKSPACE_MID_COMPOSITION_TRACE,
  CANDIDATE_ARROW_NAVIGATION_TRACE,
  CANDIDATE_ESCAPE_DISMISSAL_TRACE
]
