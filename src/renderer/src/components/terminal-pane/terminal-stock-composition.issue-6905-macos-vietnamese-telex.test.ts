// @vitest-environment happy-dom
//
// ENGINE CAVEAT — the first thing to read, because it is what this file does NOT establish.
// The capture replayed below used the macOS BUILT-IN Simple Telex input source. The reporter of
// #6905 named UniKey, iBus Bamboo and fcitx-bamboo; UniKey is Windows-only and the other two are
// Linux-only, so none of them can run on the platform they declared, and WHICH macOS Vietnamese
// engine they actually used is unconfirmed (built-in Simple Telex vs. a third-party engine such as
// OpenKey / EVKey / GoTiengViet). That open question is what gates this row's remaining criteria.
// This file pins the commit mechanism on the affected platform. It certifies NO engine, and in
// particular it does not certify the reporter's. The row's wording says "Telex or VNI"; the
// capture is Telex only, so nothing here covers VNI either. Do not cite it as Vietnamese-IME
// coverage.
//
// Source: GitHub #6905, "[Bug]: Vietnamese IME Input Broken in Terminal", reporter `dony-omg`.
// The issue template's structured platform field reads `macOS`, corroborated by the maintainer
// `os:macos` label.
//
// Recorded shape: `evidence/macos-6905-simple-telex-2026-08-06/` (cited by bundle directory, not
// filename — two bundles in that corpus carry same-named files with different contents), file
// `native-macos-vietnamese-commits-telex-text-once-without-normalizing-it.json`, SHA-256
// e70dbdc5a4d8f2671ffe92e5504114db7cb3a7454f69de9aea6b51e34e24ffc6. Injected through System Events
// on real macOS 26.1 hardware with the input source asserted live; it was not physical typing.
// The capture's own `onData` is
//   ['tiếng ', 'việt', '\r', 'o', 'r', 'd', 'i', 'n', 'a', 'r', 'y', '\r']
// and each expectation below is that array sliced at a boundary, not a hand-authored guess.
//
// Three mechanical reductions of the 99 recorded DOM records to the 84 rows below, each verified
// against the capture rather than assumed:
//   - The 15 `beforeinput` records are omitted: xterm registers no `beforeinput` listener, and
//     every one of them carries the same data/value/selection as the `compositionupdate`
//     immediately preceding it (checked for all 15, 0 mismatches).
//   - `code` is derived, because it is mechanical for every key in this session: 'Space' for the
//     space, 'Enter' for Enter, `Key<UPPER>` otherwise (checked against all 50 key records).
//   - `inputType` is omitted: all 15 `input` records are `insertCompositionText`.
// No keydown or keyup in the capture carries a modifier, a repeat, or a non-zero location.
//
// Unlike the sibling #11504 file, these assertions pin CORRECT behaviour — #6905 is NOT
// reproducible at HEAD, so this is a regression guard rather than a defect pin. It is not vacuous:
// the owner it exercises is @xterm/xterm's `CompositionHelper._finalizeComposition` in the
// resolved install (`patch_hash=8a8976e1ddd73b3747547f119f76a72f2fa3f8e6efc6e6134b267d9c7f80f65d`,
// `src/browser/input/CompositionHelper.ts`, 268 lines), and narrowing its commit range fails these
// arms in the reporter's own two directions. Measured against copies of that bundle aliased in,
// not inferred; node_modules was not written. RE-MEASURED, not re-pointed, when the composition
// dedup fix changed the patch and so the install directory: the rig
// (.tmp/ime-handoff/swarm-scratch/lane-6905-criteria/build-arms.mjs) re-derives every arm from the
// bundle the loader resolves, and all four counts below came back identical on the new bytes:
//   - DEFERRED branch (line 205), range END collapsed onto its start -> 3 failed. Both Telex
//     commits slice to '', so the first arm sees `[]` where it expects `['tiếng ']`. The
//     "garbled / never arrives" direction.
//   - DEFERRED branch (line 205), range START collapsed to 0 -> 2 failed. The first word is
//     unaffected; the second commit re-slices from the start of the textarea and emits
//     `'tiếng việt'` in place of `'việt'`. The "duplicated" direction.
//   - IMMEDIATE branch (line 163), range end collapsed onto its start -> 3 PASSED, i.e. invisible
//     here, and deliberately kept as the null control. This shape never enters that branch: every
//     keydown during a live composition in the capture is keyCode 229, so xterm's exemption holds
//     and both commits arrive via `compositionend`. It matters because
//     `evidence/6905-telex-current-owner-mutation/` names the IMMEDIATE branch — so that retained
//     mutation, applied faithfully to the bundle the loader resolves, does not discriminate this
//     row at all.
// Both live mutants still pass the ASCII assertion in the third test, failing it only on the
// Vietnamese precondition that follows — that is what makes them narrow rather than a broken build.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RecordedEvent = readonly [
  type: 'keydown' | 'keyup' | 'compositionstart' | 'compositionupdate' | 'compositionend' | 'input',
  // `key` for the key events, `data` for the composition and input events.
  payload: string,
  // `null` wherever the capture recorded the field as null for that event type.
  keyCode: number | null,
  isComposing: boolean | null,
  value: string,
  selectionStart: number,
  selectionEnd: number
]

const RECORDED_SIMPLE_TELEX_SESSION: readonly RecordedEvent[] = [
  ['keydown', 't', 229, false, '', 0, 0],
  ['compositionstart', '', null, null, '', 0, 0],
  ['compositionupdate', 't', null, null, '', 0, 0],
  ['input', 't', null, true, 't', 1, 1],
  ['keyup', 't', 84, true, 't', 1, 1],
  ['keydown', 'i', 229, true, 't', 1, 1],
  ['compositionupdate', 'ti', null, null, 't', 0, 1],
  ['input', 'ti', null, true, 'ti', 2, 2],
  ['keyup', 'i', 73, true, 'ti', 2, 2],
  ['keydown', 'e', 229, true, 'ti', 2, 2],
  ['compositionupdate', 'tie', null, null, 'ti', 0, 2],
  ['input', 'tie', null, true, 'tie', 3, 3],
  ['keyup', 'e', 69, true, 'tie', 3, 3],
  ['keydown', 'e', 229, true, 'tie', 3, 3],
  ['compositionupdate', 'tiê', null, null, 'tie', 0, 3],
  ['input', 'tiê', null, true, 'tiê', 3, 3],
  ['keyup', 'e', 69, true, 'tiê', 3, 3],
  ['keydown', 's', 229, true, 'tiê', 3, 3],
  ['compositionupdate', 'tiế', null, null, 'tiê', 0, 3],
  ['input', 'tiế', null, true, 'tiế', 3, 3],
  ['keyup', 's', 83, true, 'tiế', 3, 3],
  ['keydown', 'n', 229, true, 'tiế', 3, 3],
  ['compositionupdate', 'tiến', null, null, 'tiế', 0, 3],
  ['input', 'tiến', null, true, 'tiến', 4, 4],
  ['keyup', 'n', 78, true, 'tiến', 4, 4],
  ['keydown', 'g', 229, true, 'tiến', 4, 4],
  ['compositionupdate', 'tiếng', null, null, 'tiến', 0, 4],
  ['input', 'tiếng', null, true, 'tiếng', 5, 5],
  ['keyup', 'g', 71, true, 'tiếng', 5, 5],
  // Space is keyCode 229 here, not 32 — Simple Telex routes it through the IME, so xterm's
  // composition exemption holds and the commit arrives as a compositionend, not as a keystroke.
  ['keydown', ' ', 229, true, 'tiếng', 5, 5],
  ['compositionupdate', 'tiếng ', null, null, 'tiếng', 0, 5],
  ['input', 'tiếng ', null, true, 'tiếng ', 6, 6],
  ['compositionend', 'tiếng ', null, null, 'tiếng ', 6, 6],
  ['keyup', ' ', 32, false, 'tiếng ', 6, 6],
  ['keydown', 'v', 229, false, 'tiếng ', 6, 6],
  // Second composition starts at caret 6, so its commit range must begin after the first word.
  ['compositionstart', '', null, null, 'tiếng ', 6, 6],
  ['compositionupdate', 'v', null, null, 'tiếng ', 6, 6],
  ['input', 'v', null, true, 'tiếng v', 7, 7],
  ['keyup', 'v', 86, true, 'tiếng v', 7, 7],
  ['keydown', 'i', 229, true, 'tiếng v', 7, 7],
  ['compositionupdate', 'vi', null, null, 'tiếng v', 6, 7],
  ['input', 'vi', null, true, 'tiếng vi', 8, 8],
  ['keyup', 'i', 73, true, 'tiếng vi', 8, 8],
  ['keydown', 'e', 229, true, 'tiếng vi', 8, 8],
  ['compositionupdate', 'vie', null, null, 'tiếng vi', 6, 8],
  ['input', 'vie', null, true, 'tiếng vie', 9, 9],
  ['keyup', 'e', 69, true, 'tiếng vie', 9, 9],
  ['keydown', 'e', 229, true, 'tiếng vie', 9, 9],
  ['compositionupdate', 'viê', null, null, 'tiếng vie', 6, 9],
  ['input', 'viê', null, true, 'tiếng viê', 9, 9],
  ['keyup', 'e', 69, true, 'tiếng viê', 9, 9],
  ['keydown', 't', 229, true, 'tiếng viê', 9, 9],
  ['compositionupdate', 'viêt', null, null, 'tiếng viê', 6, 9],
  ['input', 'viêt', null, true, 'tiếng viêt', 10, 10],
  ['keyup', 't', 84, true, 'tiếng viêt', 10, 10],
  ['keydown', 'j', 229, true, 'tiếng viêt', 10, 10],
  ['compositionupdate', 'việt', null, null, 'tiếng viêt', 6, 10],
  ['input', 'việt', null, true, 'tiếng việt', 10, 10],
  ['keyup', 'j', 74, true, 'tiếng việt', 10, 10],
  // Enter arrives twice: once as keyCode 229 to commit the composition, then, after the textarea
  // has been cleared, as a real keyCode 13 that is the carriage return the shell sees.
  ['keydown', 'Enter', 229, true, 'tiếng việt', 10, 10],
  ['compositionupdate', 'việt', null, null, 'tiếng việt', 6, 10],
  ['input', 'việt', null, true, 'tiếng việt', 10, 10],
  ['compositionend', 'việt', null, null, 'tiếng việt', 10, 10],
  ['keyup', 'Enter', 13, false, 'tiếng việt', 10, 10],
  ['keydown', 'Enter', 13, false, '', 0, 0],
  ['keyup', 'Enter', 13, false, '', 0, 0],
  // Same run, input source switched to ABC: the length-matched ASCII control.
  ['keydown', 'o', 79, false, '', 0, 0],
  ['keyup', 'o', 79, false, '', 0, 0],
  ['keydown', 'r', 82, false, '', 0, 0],
  ['keyup', 'r', 82, false, '', 0, 0],
  ['keydown', 'd', 68, false, '', 0, 0],
  ['keyup', 'd', 68, false, '', 0, 0],
  ['keydown', 'i', 73, false, '', 0, 0],
  ['keyup', 'i', 73, false, '', 0, 0],
  ['keydown', 'n', 78, false, '', 0, 0],
  ['keyup', 'n', 78, false, '', 0, 0],
  ['keydown', 'a', 65, false, '', 0, 0],
  ['keyup', 'a', 65, false, '', 0, 0],
  ['keydown', 'r', 82, false, '', 0, 0],
  ['keyup', 'r', 82, false, '', 0, 0],
  ['keydown', 'y', 89, false, '', 0, 0],
  ['keyup', 'y', 89, false, '', 0, 0],
  ['keydown', 'Enter', 13, false, '', 0, 0],
  ['keyup', 'Enter', 13, false, '', 0, 0]
]

// Slice boundaries into the table above, by index.
const FIRST_COMMIT_END = 34 // through the Space keyup that closes `tiếng `
const TELEX_END = 66 // through the real Enter that sends the line
const FIRST_WORD = 'tiếng '
const SECOND_WORD = 'việt'
const ENTER = '\r'

function codeFor(key: string): string {
  if (key === ' ') {
    return 'Space'
  }
  if (key === 'Enter') {
    return 'Enter'
  }
  return `Key${key.toUpperCase()}`
}

function openTerminal(): {
  emitted: string[]
  terminal: Terminal
  textarea: HTMLTextAreaElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  if (!terminal.textarea) {
    throw new Error('xterm helper textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, terminal, textarea: terminal.textarea }
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function dispatchRecorded(textarea: HTMLTextAreaElement, record: RecordedEvent): void {
  const [type, payload, keyCode, isComposing, value, selectionStart, selectionEnd] = record
  // The capture read these off the textarea inside the listener, so they are set first: for the
  // pre-change events that is the range the IME is about to replace, and for `input` and
  // `compositionend` it is the text the deferred commit will slice.
  textarea.value = value
  textarea.setSelectionRange(selectionStart, selectionEnd)

  if (type === 'keydown' || type === 'keyup') {
    const event = new KeyboardEvent(type, {
      bubbles: true,
      code: codeFor(payload),
      isComposing: isComposing ?? false,
      key: payload
    })
    Object.defineProperty(event, 'keyCode', { value: keyCode })
    textarea.dispatchEvent(event)
    return
  }
  if (type === 'input') {
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        data: payload,
        inputType: 'insertCompositionText',
        isComposing: isComposing ?? false
      })
    )
    return
  }
  const event = new CompositionEvent(type, { bubbles: true })
  Object.defineProperty(event, 'data', { value: payload })
  textarea.dispatchEvent(event)
}

// Every keystroke in the capture is ~100 ms from the next, so each of xterm's deferred commit
// timers had already run before the following event arrived. Replaying without draining would let
// the first commit read the textarea after the SECOND word was typed into it, which is a different
// session from the one recorded. Two drains: the commit send, and the window that closes it.
async function replay(
  textarea: HTMLTextAreaElement,
  records: readonly RecordedEvent[]
): Promise<void> {
  for (const record of records) {
    dispatchRecorded(textarea, record)
    await nextTask()
    await nextTask()
  }
}

describe('#6905 macOS Vietnamese Telex committed through the stock xterm composition owner', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('sends the first Telex word once, whole, at the recorded space boundary', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    await replay(textarea, RECORDED_SIMPLE_TELEX_SESSION.slice(0, FIRST_COMMIT_END))

    // One event, not one per keystroke and not one per compositionupdate; and the tone-bearing
    // `ế` intact, which is what the reporter says arrives garbled.
    expect(emitted).toEqual([FIRST_WORD])
    expect(textarea.value).toBe(FIRST_WORD)
    terminal.dispose()
  })

  it('sends the second Telex word without repeating the first', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    await replay(textarea, RECORDED_SIMPLE_TELEX_SESSION.slice(0, TELEX_END))

    expect(emitted).toEqual([FIRST_WORD, SECOND_WORD, ENTER])
    // The line the shell receives, spelled out: no doubled syllable, no dropped tone mark, no
    // decomposed sequence. `tiếng` is 5 code points here, not 6 — an NFD normalization would
    // split `ế` and lengthen this string without changing how it renders.
    expect(emitted.join('')).toBe('tiếng việt\r')
    expect([...emitted.join('')].length).toBe(11)
    terminal.dispose()
  })

  it('leaves the same-run ASCII control byte-exact', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    await replay(textarea, RECORDED_SIMPLE_TELEX_SESSION)

    // Asserted before the precondition deliberately: a mutation of the composition owner has to
    // leave this line alone to count as narrow, and putting it first means a run that fails the
    // Vietnamese arms still records that the ASCII tail survived.
    expect(emitted.slice(-9)).toEqual(['o', 'r', 'd', 'i', 'n', 'a', 'r', 'y', ENTER])
    // Precondition: the tail above shares its session with a real composition, so it is a same-run
    // control rather than a bare keyboard test that could pass with the composition path dead.
    expect(emitted.slice(0, 3)).toEqual([FIRST_WORD, SECOND_WORD, ENTER])
    terminal.dispose()
  })
})
