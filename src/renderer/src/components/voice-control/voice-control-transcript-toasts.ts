import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useVoiceControlTranscript } from './voice-control-store'
import type { VoiceControlTranscriptLine } from './voice-control-transcript-events'

export const VOICE_CONTROL_TRANSCRIPT_TOAST_MIN_INTERVAL_MS = 1500

export type TranscriptToastThrottleState = {
  /** When the last toast fired (ms since epoch); null before the first. */
  lastFiredAt: number | null
  /** Newest line held back by the throttle, with the earliest time it may fire. */
  pending: { line: VoiceControlTranscriptLine; fireAt: number } | null
}

export function initialTranscriptToastThrottleState(): TranscriptToastThrottleState {
  return { lastFiredAt: null, pending: null }
}

export type TranscriptToastOffer = {
  next: TranscriptToastThrottleState
  /** Line to toast immediately, when the throttle window is open. */
  fireNow: VoiceControlTranscriptLine | null
}

/**
 * Offer one new transcript line. Inside the throttle window the line replaces any
 * held-back one (a burst toasts only its latest line); otherwise it fires at once.
 */
export function offerTranscriptToastLine(
  state: TranscriptToastThrottleState,
  line: VoiceControlTranscriptLine,
  now: number,
  minIntervalMs = VOICE_CONTROL_TRANSCRIPT_TOAST_MIN_INTERVAL_MS
): TranscriptToastOffer {
  const readyAt =
    state.lastFiredAt === null ? Number.NEGATIVE_INFINITY : state.lastFiredAt + minIntervalMs
  if (!state.pending && now >= readyAt) {
    return { next: { lastFiredAt: now, pending: null }, fireNow: line }
  }
  const pending = state.pending ? { line, fireAt: state.pending.fireAt } : { line, fireAt: readyAt }
  return { next: { lastFiredAt: state.lastFiredAt, pending }, fireNow: null }
}

export type TranscriptToastClaim = {
  next: TranscriptToastThrottleState
  /** Held-back line whose slot has arrived, when one was due. */
  fire: VoiceControlTranscriptLine | null
}

/** Fire the held-back line once its throttle slot arrives. */
export function claimDueTranscriptToast(
  state: TranscriptToastThrottleState,
  now: number
): TranscriptToastClaim {
  if (state.pending && now >= state.pending.fireAt) {
    return { next: { lastFiredAt: now, pending: null }, fire: state.pending.line }
  }
  return { next: state, fire: null }
}

function toastTranscriptLine(line: VoiceControlTranscriptLine): void {
  toast.message(
    line.speaker === 'user'
      ? translate(
          'auto.components.voice.control.voice.control.transcript.toasts.b4a9a7f737',
          'You: {{text}}',
          { text: line.text }
        )
      : line.text
  )
}

/** Toasts new control transcript lines, throttled so a fast exchange stays readable. */
export function useVoiceControlTranscriptToasts(): void {
  const transcript = useVoiceControlTranscript()
  const lastLineRef = useRef<VoiceControlTranscriptLine | null>(null)
  // Lazy init: the useRef argument runs on every render, so the state starts as null.
  const throttleRef = useRef<TranscriptToastThrottleState | null>(null)
  if (throttleRef.current === null) {
    throttleRef.current = initialTranscriptToastThrottleState()
  }
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (transcript.length === 0) {
      // Session reset: forget what was seen and drop any held-back toast.
      lastLineRef.current = null
      throttleRef.current = initialTranscriptToastThrottleState()
      return
    }

    const last = lastLineRef.current
    const lastIndex = last ? transcript.lastIndexOf(last) : -1
    // Rolled past the ring limit: toast only the newest line, not replayed history.
    const newLines =
      last && lastIndex === -1 ? transcript.slice(-1) : transcript.slice(lastIndex + 1)
    if (newLines.length > 0) {
      lastLineRef.current = transcript.at(-1) ?? null

      const now = Date.now()
      let throttle = throttleRef.current ?? initialTranscriptToastThrottleState()
      for (const line of newLines) {
        const offer = offerTranscriptToastLine(throttle, line, now)
        throttle = offer.next
        if (offer.fireNow) {
          toastTranscriptLine(offer.fireNow)
        }
      }
      throttleRef.current = throttle

      const pending = throttle.pending
      if (pending) {
        // Coalescing keeps the original fireAt, so rescheduling per change is correct.
        timerRef.current = setTimeout(
          () => {
            timerRef.current = null
            const latest = throttleRef.current
            if (!latest) {
              return
            }
            const claim = claimDueTranscriptToast(latest, Date.now())
            throttleRef.current = claim.next
            if (claim.fire) {
              toastTranscriptLine(claim.fire)
            }
          },
          Math.max(0, pending.fireAt - now)
        )
      }
    }

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [transcript])
}
