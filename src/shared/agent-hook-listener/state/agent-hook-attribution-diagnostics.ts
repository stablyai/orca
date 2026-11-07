type AttributionReason = 'unknown_tab_id' | 'empty_pane_key'
type PaneOwner = { paneKey: string; connectionId?: string | null; worktreeId?: string }

const COOLDOWN_MS = 5 * 60_000
const MAX_OWNERS = 128

/** Diagnostic admission only: unresolved observations must still be queued and retried. */
export class AgentHookAttributionDiagnostics {
  private readonly reported = new Map<string, number>()
  private readonly overflowAt: Partial<Record<AttributionReason, number>> = {}

  shouldReport(reason: AttributionReason, owner?: PaneOwner): boolean {
    const now = Date.now()
    // Entries stay in report-time order; stop as soon as the oldest survivor is still cooling down.
    for (const [key, at] of this.reported) {
      if (now - at < COOLDOWN_MS) {
        break
      }
      this.reported.delete(key)
    }
    const key = this.key(reason, owner)
    if (this.reported.has(key)) {
      return false
    }
    if (this.reported.size >= MAX_OWNERS) {
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
    if (this.reported.size > 0) {
      this.reported.delete(this.key('unknown_tab_id', owner))
    }
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
