import { useEffect, useState } from 'react'
import {
  PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS,
  type PaneForegroundAgentEntry
} from '@/store/slices/pane-foreground-agent'

/** Earliest upcoming attribution-evidence expiry among entries, or null. */
export function earliestPaneForegroundAgentEvidenceExpiry(
  entries: Record<string, PaneForegroundAgentEntry>,
  now: number
): number | null {
  let earliest: number | null = null
  for (const entry of Object.values(entries)) {
    if (!entry.agent || entry.observedAt === undefined) {
      continue
    }
    const expiry = entry.observedAt + PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS
    if (expiry <= now) {
      continue
    }
    earliest = earliest === null ? expiry : Math.min(earliest, expiry)
  }
  return earliest
}

/**
 * Re-render trigger for TTL-gated process-identity attribution: store updates
 * only happen when evidence is (re)published, so nothing re-renders when the
 * last publish silently crosses its TTL. Returns a tick that bumps just past
 * the earliest upcoming expiry; consumers add it to their memo deps so a
 * past-TTL working ring/row drops without waiting for unrelated store churn.
 */
export function usePaneForegroundAgentEvidenceExpiryTick(
  entries: Record<string, PaneForegroundAgentEntry>
): number {
  const [tick, setTick] = useState(0)
  // Why: `tick` is a dep so the effect re-arms for the next-earliest expiry
  // after firing (entries observed at different times expire independently).
  useEffect(() => {
    const now = Date.now()
    const earliest = earliestPaneForegroundAgentEvidenceExpiry(entries, now)
    if (earliest === null) {
      return
    }
    const timer = setTimeout(() => setTick((value) => value + 1), earliest - now + 1)
    return () => clearTimeout(timer)
  }, [entries, tick])
  return tick
}
