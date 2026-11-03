import { BoundedMap } from './bounded-map'

type AttributionReason = 'unknown_tab_id' | 'empty_pane_key'
type PaneOwner = { paneKey: string; connectionId?: string | null; worktreeId?: string }

const COOLDOWN_MS = 5 * 60_000
const MAX_OWNERS = 128

/** Diagnostic admission only: unresolved observations must still be queued and retried. */
export class AgentHookAttributionDiagnostics {
  private readonly reported = new BoundedMap<string, number>({ maxEntries: MAX_OWNERS })
  private readonly overflowAt: Partial<Record<AttributionReason, number>> = {}
  private nextSweepAt = 0

  shouldReport(reason: AttributionReason, owner?: PaneOwner): boolean {
    const now = Date.now()
    if (now >= this.nextSweepAt) {
      for (const [key, at] of this.reported.entries()) {
        if (now - at >= COOLDOWN_MS) {
          this.reported.delete(key)
        }
      }
      this.nextSweepAt = now + COOLDOWN_MS
    }
    const key = this.key(reason, owner)
    const previous = this.reported.peek(key)
    if (previous !== undefined && now - previous < COOLDOWN_MS) {
      return false
    }
    if (previous === undefined && this.reported.size >= MAX_OWNERS) {
      // Avoid eviction churn when a flood cycles through more owners than fit in memory.
      const overflow = this.overflowAt[reason]
      if (overflow !== undefined && now - overflow < COOLDOWN_MS) {
        return false
      }
      this.overflowAt[reason] = now
      return true
    }
    this.reported.set(key, now)
    return true
  }

  resolved(owner: PaneOwner): void {
    this.reported.delete(this.key('unknown_tab_id', owner))
  }

  private key(reason: AttributionReason, owner?: PaneOwner): string {
    return JSON.stringify([
      reason,
      owner?.connectionId ?? null,
      owner?.worktreeId ?? null,
      owner?.paneKey ?? null
    ])
  }
}
