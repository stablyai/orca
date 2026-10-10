import { describe, expect, it } from 'vitest'
import type { VoiceControlTranscriptLine } from './voice-control-transcript-events'
import {
  claimDueTranscriptToast,
  initialTranscriptToastThrottleState,
  offerTranscriptToastLine,
  VOICE_CONTROL_TRANSCRIPT_TOAST_MIN_INTERVAL_MS
} from './voice-control-transcript-toasts'

const INTERVAL = VOICE_CONTROL_TRANSCRIPT_TOAST_MIN_INTERVAL_MS

type TranscriptEvent = { text: string; at: number }

/**
 * Fold lines and their arrival times through the throttle the way the hook does:
 * claim any due held-back toast, offer the line, then flush the trailing slot.
 */
function fireSchedule(events: TranscriptEvent[]): { text: string; at: number }[] {
  let state = initialTranscriptToastThrottleState()
  const fired: { text: string; at: number }[] = []
  for (const event of events) {
    const line: VoiceControlTranscriptLine = { speaker: 'coordinator', text: event.text }
    const claim = claimDueTranscriptToast(state, event.at)
    state = claim.next
    if (claim.fire) {
      fired.push({ text: claim.fire.text, at: event.at })
    }
    const offer = offerTranscriptToastLine(state, line, event.at)
    state = offer.next
    if (offer.fireNow) {
      fired.push({ text: offer.fireNow.text, at: event.at })
    }
  }
  const claim = claimDueTranscriptToast(state, state.pending?.fireAt ?? Number.MAX_SAFE_INTEGER)
  if (claim.fire && state.pending) {
    fired.push({ text: claim.fire.text, at: state.pending.fireAt })
  }
  return fired
}

describe('transcript toast throttle', () => {
  it('fires every line when arrivals are spaced past the interval', () => {
    const fired = fireSchedule([
      { text: 'one', at: 0 },
      { text: 'two', at: INTERVAL },
      { text: 'three', at: INTERVAL * 2 + 100 }
    ])
    expect(fired).toEqual([
      { text: 'one', at: 0 },
      { text: 'two', at: INTERVAL },
      { text: 'three', at: INTERVAL * 2 + 100 }
    ])
  })

  it('coalesces a burst to its latest line at the window edge', () => {
    const fired = fireSchedule([
      { text: 'one', at: 0 },
      { text: 'two', at: 100 },
      { text: 'three', at: 200 }
    ])
    expect(fired).toEqual([
      { text: 'one', at: 0 },
      { text: 'three', at: INTERVAL }
    ])
  })

  it('keeps throttling after a coalesced burst', () => {
    const fired = fireSchedule([
      { text: 'one', at: 0 },
      { text: 'two', at: 100 },
      { text: 'three', at: 2000 },
      { text: 'four', at: 2100 }
    ])
    expect(fired).toEqual([
      { text: 'one', at: 0 },
      { text: 'two', at: 2000 },
      { text: 'four', at: 2000 + INTERVAL }
    ])
  })

  it('drops the held-back line when a later claim runs before any new line', () => {
    let state = initialTranscriptToastThrottleState()
    const line = (text: string): VoiceControlTranscriptLine => ({ speaker: 'user', text })
    const first = offerTranscriptToastLine(state, line('one'), 0)
    expect(first.fireNow?.text).toBe('one')
    state = offerTranscriptToastLine(first.next, line('two'), 100).next
    expect(state.pending?.line.text).toBe('two')
    const claim = claimDueTranscriptToast(state, INTERVAL)
    expect(claim.fire?.text).toBe('two')
    expect(claimDueTranscriptToast(claim.next, INTERVAL * 2).fire).toBeNull()
  })
})
