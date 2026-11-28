import type { IDisposable } from '@xterm/xterm'

export type TerminalImeCompositionTracker = IDisposable & {
  isActive: () => boolean
  /** True while a live composition's preedit text contains CJK script — the platform-neutral
   *  candidate-window signal (macOS source bridge was removed; Vietnamese Telex/VNI stays Latin). */
  hasCjkCompositionText: () => boolean
  /** Candidate-key ownership spans live composition and a brief trailing release window. */
  isCandidateKeyGuardActive: () => boolean
}

// Han, Kana, Bopomofo, Hangul/Jamo and CJK symbols/fullwidth forms: text an inline Latin IME
// (Vietnamese Telex/VNI, Pinyin preedit) never produces.
const CJK_COMPOSITION_TEXT_PATTERN =
  /[\u1100-\u11ff\u2e80-\u30ff\u3100-\u318f\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

export function hasCjkCompositionText(text: string | null | undefined): boolean {
  return text !== null && text !== undefined && CJK_COMPOSITION_TEXT_PATTERN.test(text)
}

// Suppressed keys produce no input event to unstick a missed compositionend; expire ownership to avoid permanently dead Space/digits.
export const TERMINAL_IME_CANDIDATE_GUARD_STALE_COMPOSITION_EXPIRY_MS = 10_000
// A narrow post-end window absorbs Sogou/fcitx trailing plain candidate keys without blocking ordinary typing.
export const TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS = 250

export function installTerminalImeCompositionTracker(
  terminalElement: HTMLElement | null | undefined,
  options?: { now?: () => number }
): TerminalImeCompositionTracker {
  const now = options?.now ?? ((): number => Date.now())
  let active = false
  let cjkCompositionText = false
  let lastCompositionEventAt: number | null = null
  let compositionEndedAt: number | null = null
  let sawEmptyCompositionUpdate = false

  const isActiveAt = (at: number): boolean =>
    active &&
    (lastCompositionEventAt === null ||
      at - lastCompositionEventAt <= TERMINAL_IME_CANDIDATE_GUARD_STALE_COMPOSITION_EXPIRY_MS)

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

  if (!terminalElement) {
    return {
      isActive: () => active,
      hasCjkCompositionText: () => false,
      isCandidateKeyGuardActive,
      dispose: () => undefined
    }
  }

  const markActive = (): void => {
    active = true
    cjkCompositionText = false
    lastCompositionEventAt = now()
    compositionEndedAt = null
    sawEmptyCompositionUpdate = false
  }
  const updateComposition = (event: Event): void => {
    lastCompositionEventAt = now()
    // Empty Sogou/fcitx updates can leave candidates open; only end, non-composition input or blur deactivates.
    if (!(event instanceof CompositionEvent)) {
      return
    }
    if (event.data === '') {
      sawEmptyCompositionUpdate = true
      return
    }
    active = true
    cjkCompositionText = hasCjkCompositionText(event.data)
  }
  const handleCompositionEnd = (): void => {
    active = false
    cjkCompositionText = false
    // Only empty Sogou/fcitx updates justify the trailing guard; a broader rule swallows real typing.
    compositionEndedAt = sawEmptyCompositionUpdate ? now() : null
    sawEmptyCompositionUpdate = false
  }
  const handleInput = (event: Event): void => {
    if (event instanceof InputEvent && event.inputType === 'insertCompositionText') {
      cjkCompositionText = hasCjkCompositionText(event.data)
      return
    }
    active = false
    cjkCompositionText = false
    // Non-composition input proves ordinary typing resumed; release trailing key ownership.
    compositionEndedAt = null
    sawEmptyCompositionUpdate = false
  }
  const markInactive = (): void => {
    active = false
    cjkCompositionText = false
    lastCompositionEventAt = null
    compositionEndedAt = null
    sawEmptyCompositionUpdate = false
  }

  terminalElement.addEventListener('compositionstart', markActive, true)
  terminalElement.addEventListener('compositionupdate', updateComposition, true)
  terminalElement.addEventListener('compositionend', handleCompositionEnd, true)
  terminalElement.addEventListener('input', handleInput, true)
  terminalElement.addEventListener('blur', markInactive, true)

  return {
    isActive: () => isActiveAt(now()),
    hasCjkCompositionText: () => isActiveAt(now()) && cjkCompositionText,
    isCandidateKeyGuardActive,
    dispose: () => {
      terminalElement.removeEventListener('compositionstart', markActive, true)
      terminalElement.removeEventListener('compositionupdate', updateComposition, true)
      terminalElement.removeEventListener('compositionend', handleCompositionEnd, true)
      terminalElement.removeEventListener('input', handleInput, true)
      terminalElement.removeEventListener('blur', markInactive, true)
    }
  }
}
