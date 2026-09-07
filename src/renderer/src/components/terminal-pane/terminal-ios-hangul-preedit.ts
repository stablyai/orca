import type { IDisposable } from '@xterm/xterm'
import { isHangulJamoKeyText } from './hangul-jamo-key'

// Why: iPadOS composes Hangul from a hardware keyboard with no composition
// events at all (#13345). Each jamo arrives as a plain keydown while the IME
// rewrites the syllable in place in the helper textarea —
// `deleteContentBackward` then a replacing `insertText`. xterm consumes the
// keydown, so the raw compatibility jamo reaches the PTY and the composed
// syllable is dropped: `한글` arrives as `ㅎㅏㄴㄱㅡㄹ`.
//
// The keydown is handed to the system by `shouldBypassXtermForIosTextEdit`, and
// the syllable it builds is held here until the IME proves it is final —
// nothing is ever sent and then retracted, so raw-mode TUIs never see DEL bytes
// they would have to interpret as "erase one cell".
//
// Everything is driven from `input`. iPadOS delivers it later than a macrotask,
// so any timer-based read of the field loses the race and concludes, wrongly,
// that nothing was composed.

type OpenPreedit = {
  /** Field text preceding the syllable; everything after it is uncommitted. */
  baseValue: string
  /** Held back: shown, not sent. The open syllable, plus the one before it
   *  while a migrating batchim could still pull back into it. */
  heldText: string
  /** The jamo that opened the hold, owed to the PTY if the IME never writes. */
  openKey: string
  /** Set once the IME has written to the field, which retires `openKey`. */
  imeWrote: boolean
  /** What the last keydown asked the IME to do to the syllable. */
  editKind: 'compose' | 'erase'
}

export type TerminalIosHangulPreedit = IDisposable & {
  /** The text currently held back from the PTY, or '' when none is. */
  heldText: () => string
}

export type TerminalIosHangulPreeditOptions = {
  terminalElement: HTMLElement | null | undefined
  /** Whether a composition session is under way, which bars a hold from opening
   *  over it — Chinese pinyin on the same device does run one, and xterm's
   *  CompositionHelper already commits it. Must be derived and expiring, not
   *  latched: a session that never ends would otherwise disable the pane. */
  isCompositionActive: () => boolean
  /** Screen reader mode writes the textarea itself, so a field diff would not
   *  be the IME's alone. */
  isScreenReaderMode: () => boolean
  sendInput: (data: string) => void
  /** Draws the open syllable; called with '' when there is none. */
  renderPreedit?: (text: string) => void
}

const NO_OP_PREEDIT: TerminalIosHangulPreedit = {
  heldText: () => '',
  dispose: () => undefined
}

function asHelperTextarea(target: EventTarget | null): HTMLTextAreaElement | null {
  if (!(target instanceof HTMLTextAreaElement)) {
    return null
  }
  return target.classList.contains('xterm-helper-textarea') ? target : null
}

function isUnmodified(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.altKey && !event.metaKey
}

function isJamoKey(event: KeyboardEvent): boolean {
  return isHangulJamoKeyText(event.key) && isUnmodified(event)
}

function isDeletion(event: Event): boolean {
  return event instanceof InputEvent && event.inputType.startsWith('delete')
}

/** One field rewrite, located: where the IME began and what it put there. */
type FieldEdit = {
  /** Index of the first character it changed. */
  start: number
  /** What it wrote from `start` on; empty when the rewrite wrote nothing. */
  text: string
}

/**
 * Why NFC: a decomposed field grows `ᄒ` -> `하` -> `한` by appending, and an
 * append is exactly what the diff reads as the previous syllable settling — so
 * an NFD source would put one bare jamo on the wire per keystroke. Composed,
 * the same three keystrokes rewrite one character in place, as the device trace
 * does. Idempotent on the NFC text iPadOS was recorded producing.
 */
function normalizeFieldText(value: string): string {
  return value.normalize('NFC')
}

/**
 * Diffs two field states, taking the common prefix as where the IME began.
 *
 * Why not "did the tail grow past what is held": Korean batchim migration
 * rewrites in place. `깨` + `ㅈ` becomes `깾` — a different codepoint, not an
 * extension — and only becomes `깨주` once the next vowel decides where the `ㅈ`
 * belongs. Any monotonic-growth assumption stalls there.
 *
 * No common-suffix half, unlike the usual textarea-IME diff: the IME edits at
 * the caret and the caret is the end of the helper textarea, so there is never
 * an untouched tail to discount.
 */
function diffFieldEdit(prev: string, next: string): FieldEdit {
  const limit = Math.min(prev.length, next.length)
  let start = 0
  while (start < limit && prev[start] === next[start]) {
    start += 1
  }
  return { start, text: next.slice(start) }
}

/** True for input the browser attributes to a composition session, whichever
 *  order it interleaves those events in. */
function isCompositionOwnedInput(event: Event): boolean {
  return (
    event instanceof InputEvent &&
    (event.isComposing === true || event.inputType === 'insertCompositionText')
  )
}

/**
 * Holds the Hangul syllable iPadOS is still building and commits it only once
 * the IME proves it final, so the PTY sees one write per syllable.
 */
export function installTerminalIosHangulPreedit(
  options: TerminalIosHangulPreeditOptions
): TerminalIosHangulPreedit {
  const root = options.terminalElement
  if (!root) {
    return NO_OP_PREEDIT
  }

  let preedit: OpenPreedit | null = null

  const render = (text: string): void => options.renderPreedit?.(text)

  const close = (): void => {
    preedit = null
    render('')
  }

  const commit = (): void => {
    const open = preedit
    if (!open) {
      return
    }
    // A hold the IME never wrote to still owes the keystroke it swallowed.
    const text =
      open.heldText || (!open.imeWrote && isHangulJamoKeyText(open.openKey) ? open.openKey : '')
    close()
    if (text) {
      options.sendInput(text)
    }
  }

  const discard = (textarea: HTMLTextAreaElement): void => {
    const open = preedit
    if (!open) {
      return
    }
    // The cancelled syllable never reached the PTY, so it must not survive in
    // the field either.
    textarea.value = open.baseValue
    close()
  }

  /**
   * Re-derives the hold from the field, releasing whatever the IME has stopped
   * rewriting.
   *
   * A syllable is settled once the IME's own edit point has moved past it: up
   * to that index the batchim question — does this consonant end this syllable
   * or start the next — is already answered, and nothing there can change
   * without a keystroke that ends the hold anyway.
   */
  const sync = (textarea: HTMLTextAreaElement): void => {
    const open = preedit
    if (!open) {
      return
    }
    const value = normalizeFieldText(textarea.value)
    if (!value.startsWith(open.baseValue)) {
      // The field was rewritten out from under the hold; commit rather than
      // measure against text that is gone.
      commit()
      return
    }
    const tail = value.slice(open.baseValue.length)
    if (tail.length === 0) {
      // Backspace can decompose as delete-then-insert, so an emptied field is
      // not proof the syllable is gone — only that this half of the rewrite
      // wrote nothing. The hold stays open, empty; the Backspace that finds it
      // empty is the one the PTY gets. Nothing was sent, so nothing needs
      // undoing either way.
      open.heldText = ''
      render('')
      return
    }
    const edit = diffFieldEdit(open.heldText, tail)
    // An edit that wrote nothing settles nothing: a rewrite landing on the same
    // text, or a Backspace shortening the tail, is not the IME deciding.
    if (edit.start > 0 && edit.text.length > 0) {
      const settled = tail.slice(0, edit.start)
      open.baseValue += settled
      options.sendInput(settled)
    }
    open.heldText = value.slice(open.baseValue.length)
    render(open.heldText)
  }

  const handleKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) {
      return
    }
    const textarea = root.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (!textarea) {
      return
    }
    if (preedit) {
      preedit.editKind = 'compose'
      if (event.key === 'Escape' && isUnmodified(event)) {
        // Escape cancels the syllable the way it cancels a composition. Stopped
        // here so xterm cannot also send it; the default action still lets the
        // IME clear its own state.
        event.stopImmediatePropagation()
        discard(textarea)
        return
      }
      if (event.key === 'Backspace' && isUnmodified(event)) {
        if (!preedit.heldText) {
          // Nothing left to decompose: this erase is the PTY's, and xterm sends it.
          close()
          return
        }
        // Backspace decomposes the held syllable in the field rather than
        // erasing a written cell, so it must not reach the PTY as DEL.
        preedit.editKind = 'erase'
        event.stopImmediatePropagation()
        return
      }
      if (isJamoKey(event)) {
        return
      }
      // Anything else ends the syllable, and runs before xterm sends the key.
      commit()
      return
    }
    if (
      isJamoKey(event) &&
      event.isComposing !== true &&
      !options.isCompositionActive() &&
      !options.isScreenReaderMode()
    ) {
      preedit = {
        baseValue: normalizeFieldText(textarea.value),
        heldText: '',
        openKey: event.key,
        imeWrote: false,
        editKind: 'compose'
      }
    }
  }

  const handleInput = (event: Event): void => {
    if (!preedit) {
      return
    }
    const textarea = asHelperTextarea(event.target)
    if (!textarea) {
      return
    }
    if (isCompositionOwnedInput(event)) {
      // A session took the field over; it owns the commit from here. Read off
      // the event rather than the session state, so this cannot depend on which
      // `input` listener on the pane element happens to run first.
      commit()
      return
    }
    // Why: the field keeps the syllable so the IME can rewrite it, and xterm
    // must not read that as fresh input.
    event.stopImmediatePropagation()
    preedit.imeWrote = true
    if (preedit.editKind === 'compose' && isDeletion(event)) {
      // Half of the delete-then-insert the IME uses to replace a growing
      // syllable. Reading the field between the two would see it emptied.
      return
    }
    sync(textarea)
  }

  // A real session owns the field from here, so anything held is final.
  const handleCompositionStart = (): void => commit()
  const handleBlur = (): void => commit()

  root.addEventListener('keydown', handleKeyDown, true)
  root.addEventListener('input', handleInput, true)
  root.addEventListener('compositionstart', handleCompositionStart, true)
  root.addEventListener('blur', handleBlur, true)

  return {
    heldText: () => preedit?.heldText ?? '',
    dispose: () => {
      root.removeEventListener('keydown', handleKeyDown, true)
      root.removeEventListener('input', handleInput, true)
      root.removeEventListener('compositionstart', handleCompositionStart, true)
      root.removeEventListener('blur', handleBlur, true)
      close()
    }
  }
}
