import type { IDisposable } from '@xterm/xterm'

export type TerminalImeCompositionTracker = IDisposable & {
  isActive: () => boolean
  /** Candidate-key ownership spans live composition and a brief trailing release window. */
  isCandidateKeyGuardActive: () => boolean
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
      isCandidateKeyGuardActive,
      dispose: () => undefined
    }
  }

  const markActive = (): void => {
    active = true
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
  }
  const handleCompositionEnd = (): void => {
    active = false
    // Only empty Sogou/fcitx updates justify the trailing guard; a broader rule swallows real typing.
    compositionEndedAt = sawEmptyCompositionUpdate ? now() : null
    sawEmptyCompositionUpdate = false
  }
  const handleInput = (event: Event): void => {
    if (event instanceof InputEvent && event.inputType === 'insertCompositionText') {
      return
    }
    active = false
    // Non-composition input proves ordinary typing resumed; release trailing key ownership.
    compositionEndedAt = null
    sawEmptyCompositionUpdate = false
  }
  const markInactive = (): void => {
    active = false
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
