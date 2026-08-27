import type { IDisposable } from '@xterm/xterm'

export type TerminalImeCompositionTracker = IDisposable & {
  isActive: () => boolean
  /** True while candidate-selection keys (Space/digits) should be treated as
   *  IME-owned: during a live composition, and briefly after compositionend to
   *  absorb the committing key's trailing press/release. */
  isCandidateKeyGuardActive: () => boolean
  /** True when the most recent preedit was Hangul, where a bare digit ends the
   *  syllable as literal text instead of picking a candidate. Expires with the
   *  same staleness window as the other guards. */
  isHangulPreedit: () => boolean
  /** True for a short window after any compositionend (real commits, not just
   *  the Sogou/fcitx empty-update case). Distinguishes "the next syllable of
   *  the word the user is still typing" from "the first keystroke after this
   *  element gained focus or the input source changed," which never fired a
   *  compositionend yet and so is never inside this window. */
  isWithinSyllableBoundaryGuard: () => boolean
}

// Jamo, compatibility jamo, extended jamo, and precomposed syllables — every
// form a Hangul preedit can take while a syllable is being assembled.
const HANGUL_PREEDIT_PATTERN = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힣]/

// Why: suppressed candidate keys are preventDefault-ed and fire no input
// event, so a stale tracker (missed compositionend) has no natural unstick
// path. Expire the guard so Space/digits cannot stay dead indefinitely.
export const TERMINAL_IME_CANDIDATE_GUARD_STALE_COMPOSITION_EXPIRY_MS = 10_000
// Why: Sogou/fcitx can deliver the committing Space/digit as plain keydown and
// keyup after compositionend; a narrow window absorbs those trailing events
// without making the keys globally unavailable after IME use.
export const TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS = 250
// Why (#16042): xterm-bypass-policy exempts a standalone Process keydown (229)
// so the *first* key after this element gains focus — stale macOS text input
// context, or an input-source switch — can still commit. But `compositionActive`
// alone can't tell that case apart from "the next syllable of the same word,"
// since a syllable's compositionend also leaves composition inactive. Multi-
// syllable Hangul (한글, 두벌식) commits one syllable per compositionend, so
// without this window every syllable after the first looked like a fresh
// focus/switch and got the same exemption — letting xterm swallow or corrupt
// the next syllable's opening jamo instead of the browser composing it.
// 500ms comfortably covers back-to-back syllables in normal typing cadence
// while remaining short enough that a deliberate input-source switch — which
// takes a menu click or shortcut plus reorientation — clears it first.
export const TERMINAL_IME_SYLLABLE_BOUNDARY_GUARD_MS = 500

export function installTerminalImeCompositionTracker(
  terminalElement: HTMLElement | null | undefined,
  options?: { now?: () => number }
): TerminalImeCompositionTracker {
  const now = options?.now ?? ((): number => Date.now())
  let active = false
  let lastCompositionEventAt: number | null = null
  let compositionEndedAt: number | null = null
  // Why separate from compositionEndedAt: that field only arms for the
  // Sogou/fcitx empty-update case the candidate guard cares about. This one
  // marks every real compositionend, including ordinary Hangul syllable
  // commits, so the bypass policy can tell "next syllable" from "first key
  // since focus/switch" (see TERMINAL_IME_SYLLABLE_BOUNDARY_GUARD_MS above).
  let lastSyllableCommittedAt: number | null = null
  let sawEmptyCompositionUpdate = false
  // Why the preedit and not compositionend data: a Pinyin IME's preedit is the
  // Latin spelling it is picking candidates for, while its compositionend data
  // is the committed Han text. Reading the commit would misclassify Pinyin.
  let hangulPreedit = false

  const isActiveAt = (at: number): boolean =>
    active &&
    (lastCompositionEventAt === null ||
      at - lastCompositionEventAt <= TERMINAL_IME_CANDIDATE_GUARD_STALE_COMPOSITION_EXPIRY_MS)

  // Why time-bound: an engine switch (Hangul -> Pinyin) moves no DOM focus and
  // the orphan-digit path emits no composition or input events, so a latched
  // flag would disable the Pinyin candidate-digit guard for the whole session.
  const isHangulPreeditAt = (at: number): boolean =>
    hangulPreedit &&
    lastCompositionEventAt !== null &&
    at - lastCompositionEventAt <= TERMINAL_IME_CANDIDATE_GUARD_STALE_COMPOSITION_EXPIRY_MS

  const isCandidateKeyGuardActive = (): boolean => {
    const at = now()
    if (isActiveAt(at)) {
      return true
    }
    return (
      compositionEndedAt !== null &&
      at - compositionEndedAt <= TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS
    )
  }

  const isWithinSyllableBoundaryGuard = (): boolean =>
    lastSyllableCommittedAt !== null &&
    now() - lastSyllableCommittedAt <= TERMINAL_IME_SYLLABLE_BOUNDARY_GUARD_MS

  if (!terminalElement) {
    return {
      isActive: () => active,
      isCandidateKeyGuardActive,
      isHangulPreedit: () => isHangulPreeditAt(now()),
      isWithinSyllableBoundaryGuard: () => false,
      dispose: () => undefined
    }
  }

  const markActive = (): void => {
    active = true
    lastCompositionEventAt = now()
    compositionEndedAt = null
    sawEmptyCompositionUpdate = false
    // Why safe: the following compositionupdate re-reads the preedit script.
    hangulPreedit = false
  }
  const updateComposition = (event: Event): void => {
    lastCompositionEventAt = now()
    // Why: Sogou/fcitx can emit empty compositionupdate data while its
    // candidate popup is still open — empty data must not deactivate.
    // compositionend, non-composition input, and blur own deactivation.
    if (!(event instanceof CompositionEvent)) {
      return
    }
    if (event.data === '') {
      sawEmptyCompositionUpdate = true
      return
    }
    hangulPreedit = HANGUL_PREEDIT_PATTERN.test(event.data)
    active = true
  }
  const handleCompositionEnd = (): void => {
    active = false
    // Why: only Sogou/fcitx-style empty updates prove a trailing plain
    // Space/digit is likely IME-owned; broad post-end guards drop real typing.
    compositionEndedAt = sawEmptyCompositionUpdate ? now() : null
    sawEmptyCompositionUpdate = false
    // Unlike compositionEndedAt above, this arms on every real commit —
    // ordinary Hangul syllables included — so the next syllable's opening
    // jamo doesn't read as "first key since focus/switch" (#16042).
    lastSyllableCommittedAt = now()
  }
  const handleInput = (event: Event): void => {
    if (event instanceof InputEvent && event.inputType === 'insertCompositionText') {
      return
    }
    active = false
    // Why: real non-composition input means ordinary typing resumed; keeping
    // the post-end window would swallow a legitimate Space/digit.
    compositionEndedAt = null
    sawEmptyCompositionUpdate = false
  }
  const markInactive = (): void => {
    active = false
    lastCompositionEventAt = null
    compositionEndedAt = null
    sawEmptyCompositionUpdate = false
    hangulPreedit = false
    // Why reset here too: losing focus is exactly the kind of focus handoff
    // #7102 needed the standalone-229 exemption for, so regaining focus
    // should re-arm it rather than stay suppressed from before the blur.
    lastSyllableCommittedAt = null
  }

  terminalElement.addEventListener('compositionstart', markActive, true)
  terminalElement.addEventListener('compositionupdate', updateComposition, true)
  terminalElement.addEventListener('compositionend', handleCompositionEnd, true)
  terminalElement.addEventListener('input', handleInput, true)
  terminalElement.addEventListener('blur', markInactive, true)

  return {
    isActive: () => isActiveAt(now()),
    isCandidateKeyGuardActive,
    isHangulPreedit: () => isHangulPreeditAt(now()),
    isWithinSyllableBoundaryGuard,
    dispose: () => {
      terminalElement.removeEventListener('compositionstart', markActive, true)
      terminalElement.removeEventListener('compositionupdate', updateComposition, true)
      terminalElement.removeEventListener('compositionend', handleCompositionEnd, true)
      terminalElement.removeEventListener('input', handleInput, true)
      terminalElement.removeEventListener('blur', markInactive, true)
    }
  }
}
