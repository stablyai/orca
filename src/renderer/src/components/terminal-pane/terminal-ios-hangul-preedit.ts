import type { IDisposable } from '@xterm/xterm'
import { isHangulJamoKeyText } from './hangul-jamo-key'

// iPad hardware Hangul rewrites textarea without composition events; hold syllables until final so xterm cannot send raw jamo or require DEL retractions. Drive from input because device writes arrive after macrotasks (#13345).

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
  /** Derive expiring session state: other scripts already use xterm composition, and a missing end must not latch input disabled. */
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

/** Normalize NFD to NFC so appending jamo is seen as a syllable rewrite, not separate settled keystrokes; recorded iPad NFC remains unchanged. */
function normalizeFieldText(value: string): string {
  return value.normalize('NFC')
}

/** Use common-prefix edit position, not monotonic growth: batchim migration rewrites 깨 → 깾 → 깨주. No common suffix is needed because the IME edits at the textarea’s end. */
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
    // Cancelled syllables never reached the PTY and must leave the field too.
    textarea.value = open.baseValue
    close()
  }

  /** Release only text before the IME’s edit point, where batchim placement is settled and cannot change without a hold-ending key. */
  const sync = (textarea: HTMLTextAreaElement): void => {
    const open = preedit
    if (!open) {
      return
    }
    const value = normalizeFieldText(textarea.value)
    if (!value.startsWith(open.baseValue)) {
      // External field replacement invalidates the comparison basis; commit rather than measure stale text.
      commit()
      return
    }
    const tail = value.slice(open.baseValue.length)
    if (tail.length === 0) {
      // An empty delete-half can precede replacing insertText; keep the hold open until a later Backspace owns an already-empty field.
      open.heldText = ''
      render('')
      return
    }
    const edit = diffFieldEdit(open.heldText, tail)
    // Same-text rewrites and shortening Backspace settle nothing; only text before a new edit point is final.
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
        // Consume Escape without blocking its default action: xterm must not send it, but the IME must clear its state.
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
        // Backspace decomposes unwritten preedit; do not send DEL for cells the PTY never received.
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
      // A real session takes ownership from the event, independent of pane input-listener ordering.
      commit()
      return
    }
    // Keep held field text away from xterm’s fresh-input path while the IME rewrites it.
    event.stopImmediatePropagation()
    preedit.imeWrote = true
    if (preedit.editKind === 'compose' && isDeletion(event)) {
      // Do not read the temporarily empty field between delete/insert halves.
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
