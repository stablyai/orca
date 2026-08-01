// Loads the raw ibus-hangul recording. The recording itself lives in the adjacent
// .json because it is machine output, not source: re-capture it, never hand-edit it.
//
// Capture path: tests/e2e/terminal-ime-boundary-probe.ts reads the live
// .xterm-helper-textarea while xdotool types at the X11 layer, so a real engine
// composes and the selection offsets are its own rather than a reconstruction.
// See the `origin` field in the JSON for the exact workflow run.

import type {
  ImeCompositionTrace,
  ImeTraceEvent,
  ImeTraceTargetState
} from './ime-composition-trace.test-fixtures'
import recording from './ime-recorded-ibus-hangul-trace.json'

const COMPOSITION_TYPES = new Set(['compositionend', 'compositionstart', 'compositionupdate'])
const KEY_TYPES = new Set(['keydown', 'keypress', 'keyup'])
const INPUT_TYPES = new Set(['beforeinput', 'input'])

/**
 * Narrows the JSON to the trace type. A blanket structural cast would hide the drift
 * this is here to catch: a re-captured recording that gained or lost a field would
 * type-check and then fail somewhere unrelated.
 */
function toTraceEvent(raw: (typeof recording)['events'][number], index: number): ImeTraceEvent {
  const state = raw.state as ImeTraceTargetState
  if (COMPOSITION_TYPES.has(raw.type)) {
    return {
      data: raw.data ?? '',
      state,
      type: raw.type as 'compositionend' | 'compositionstart' | 'compositionupdate'
    }
  }
  if (KEY_TYPES.has(raw.type)) {
    return {
      code: raw.code ?? '',
      isComposing: raw.isComposing === true,
      key: raw.key ?? '',
      keyCode: raw.keyCode ?? 0,
      state,
      type: raw.type as 'keydown' | 'keypress' | 'keyup'
    }
  }
  if (INPUT_TYPES.has(raw.type)) {
    return {
      data: raw.data ?? null,
      inputType: raw.inputType ?? '',
      isComposing: raw.isComposing === true,
      state,
      type: raw.type as 'beforeinput' | 'input'
    }
  }
  throw new Error(`Unrecognized recorded event type "${raw.type}" at index ${index}`)
}

/**
 * Real jamo assembly followed by a commit. Three things here are not reproducible by
 * hand, which is the whole reason this recording exists:
 *
 * 1. The Enter that commits arrives as `key: 'Process'`, `keyCode: 229`,
 *    `isComposing: true`. The submit Enter that follows the slice is `keyCode: 13`.
 * 2. ibus-hangul tears the preedit down with `deleteContentBackward` and only *then*
 *    re-inserts the committed text with `insertText`. Anything deriving committed text
 *    by diffing the buffer sees the delete and loses the character.
 * 3. `compositionend` carries `data: ''`, so it is not the commit carrier here.
 */
export const IBUS_HANGUL_TERMINAL_JAMO_COMMIT_TRACE: ImeCompositionTrace = {
  committed: recording.committed,
  env: {
    browser: 'chromium',
    engine: recording.env.engine,
    platform: 'linux'
  },
  events: recording.events.map(toTraceEvent),
  final: recording.final,
  initial: recording.initial,
  name: recording.name,
  origin: recording.origin,
  provenance: 'recorded'
}

/** Bytes the terminal actually forwarded to the PTY during this recording. */
export const IBUS_HANGUL_TERMINAL_PTY_ORACLE: readonly string[] = recording.pty
