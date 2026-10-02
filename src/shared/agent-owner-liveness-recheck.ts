/** How often an execution host re-proves each live identified owner's own process. */
export const AGENT_OWNER_RECHECK_INTERVAL_MS = 2_000

type AgentOwnerLivenessRecheckDeps = {
  /** Panes whose recorded owner is live and checkable on this host. */
  listLiveOwnerPaneKeys: () => string[]
  /** The host's exact-owner check; it coalesces, fences and publishes the verdict itself. */
  checkOwner: (paneKey: string) => Promise<unknown>
}

/**
 * One timer per execution host. An agent can exit with no hook and no prompt mark (a silent
 * crash, `claude; sleep 30`), so each live owner is re-proven on a fixed beat. Panes without an
 * owner cost nothing, and the timer exists only while some owner is live.
 */
export class AgentOwnerLivenessRecheck {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: AgentOwnerLivenessRecheckDeps) {}

  /** Call after a write that may have recorded a live owner. */
  noteLiveOwner(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => this.recheck(), AGENT_OWNER_RECHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private recheck(): void {
    const paneKeys = this.deps.listLiveOwnerPaneKeys()
    if (paneKeys.length === 0) {
      this.stop()
      return
    }
    for (const paneKey of paneKeys) {
      void this.deps.checkOwner(paneKey).catch(() => undefined)
    }
  }
}
