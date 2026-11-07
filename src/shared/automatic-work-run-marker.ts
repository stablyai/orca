// Use the prior terminal-host marker to admit automatic restores; the host owns persistence and clocks.
import { z } from 'zod'
import type { AutomaticWorkMode } from './host-spawn-admission'

export type BootIdentity = {
  /** Wall-clock boot time, compared with a tolerance; null where it cannot identify a boot. */
  bootTimeMs: number | null
  /** Exact per-boot id where the OS exposes one (Linux). */
  bootId: string | null
}

export type AutomaticWorkRunMarker = {
  schemaVersion: 1
  boot: BootIdentity
  /** `running`: automatic work was admitted and the host has not exited cleanly since. */
  state: 'running' | 'clean-exit'
  mode: AutomaticWorkMode
}

const BOOT_TIME_TOLERANCE_MS = 120_000

export function isSameBoot(a: BootIdentity, b: BootIdentity): boolean {
  if (a.bootId !== null && b.bootId !== null) {
    return a.bootId === b.bootId
  }
  if (a.bootTimeMs === null || b.bootTimeMs === null) {
    return false
  }
  return Math.abs(a.bootTimeMs - b.bootTimeMs) <= BOOT_TIME_TOLERANCE_MS
}

/** An unclean host exit during the same boot pauses automatic restores until explicit resume; a new boot uses normal budget. Existing pauses survive reboot. */
export function decideStartupAutomaticWorkMode(
  previous: AutomaticWorkRunMarker | null,
  current: BootIdentity,
  now: number
): AutomaticWorkMode {
  if (!previous) {
    return { kind: 'normal' }
  }
  if (previous.mode.kind === 'paused') {
    return previous.mode
  }
  if (previous.state === 'running' && isSameBoot(previous.boot, current)) {
    return { kind: 'paused', reason: 'unclean_host_death', since: now }
  }
  return { kind: 'normal' }
}

const MarkerSchema = z.object({
  schemaVersion: z.literal(1),
  boot: z.object({ bootTimeMs: z.number().finite().nullable(), bootId: z.string().nullable() }),
  state: z.enum(['running', 'clean-exit']),
  mode: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('normal') }),
    z.object({
      kind: z.literal('paused'),
      reason: z.enum(['unclean_host_death', 'pressure', 'operator']),
      since: z.number()
    })
  ])
})

/** Unreadable or foreign content reads as "no previous run", never as a pause. */
export function parseAutomaticWorkRunMarker(text: string): AutomaticWorkRunMarker | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const result = MarkerSchema.safeParse(parsed)
  return result.success ? result.data : null
}
