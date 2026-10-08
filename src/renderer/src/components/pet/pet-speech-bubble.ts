import type { AgentBucketCounts } from '../dashboard/useAgentBucketCounts'

export type PetSpeechKind = 'done' | 'waiting' | 'reminder'

export type PetSpeech = { kind: PetSpeechKind; count: number; id: number }

export const PET_SPEECH_REMINDER_MINUTES_DEFAULT = 10
export const PET_SPEECH_REMINDER_MINUTES_MAX = 240
export const PET_SPEECH_VISIBLE_MS = 8000

type PendingCounts = Pick<AgentBucketCounts, 'attention' | 'done'>

// Why: only a rising count speaks, so acks, recounts, and closed panes never re-announce.
export function petSpeechForCountChange(
  prev: PendingCounts,
  next: PendingCounts
): PetSpeechKind | null {
  if (next.attention > prev.attention) {
    return 'waiting'
  }
  if (next.done > prev.done) {
    return 'done'
  }
  return null
}

export function petSpeechReminderMs(minutes: number | undefined): number | null {
  const value = minutes ?? PET_SPEECH_REMINDER_MINUTES_DEFAULT
  if (!Number.isFinite(value) || value <= 0) {
    return null
  }
  return Math.min(value, PET_SPEECH_REMINDER_MINUTES_MAX) * 60_000
}

export function petSpeechText(
  template: string | undefined,
  fallback: string,
  count: number
): string {
  const text = template?.trim() || fallback
  return text.replaceAll('{count}', String(count))
}
