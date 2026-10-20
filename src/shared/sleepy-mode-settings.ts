/** Idle delays offered for Sleepy Mode. 0 means it only ever starts on request. */
export const SLEEPY_MODE_IDLE_MINUTES = [0, 5, 15, 30] as const

export type SleepyModeIdleMinutes = (typeof SLEEPY_MODE_IDLE_MINUTES)[number]

const DEFAULT_SLEEPY_MODE_IDLE_MINUTES: SleepyModeIdleMinutes = 0

/** Persisted values come from older builds and hand-edited settings, so snap to a known option. */
export function normalizeSleepyModeIdleMinutes(value: unknown): SleepyModeIdleMinutes {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SLEEPY_MODE_IDLE_MINUTES
  }
  const match = SLEEPY_MODE_IDLE_MINUTES.find((option) => option === value)
  return match ?? DEFAULT_SLEEPY_MODE_IDLE_MINUTES
}

export function sleepyModeIdleDelayMs(minutes: SleepyModeIdleMinutes): number {
  return minutes * 60_000
}
