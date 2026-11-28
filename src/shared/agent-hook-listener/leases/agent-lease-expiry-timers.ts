import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { CodexSubagentPollScheduler } from '../transcripts/codex-subagent-poll-scheduler'

type PublishRow = (row: AgentHookEventPayload) => void
export type AgentLease = { deadline: number; maxDelayMs: number }
export type AgentLeaseExpiryProvider = {
  lease(state: HookListenerState, paneKey: string): AgentLease | undefined
  settle(
    state: HookListenerState,
    paneKey: string,
    row: AgentHookEventPayload
  ): AgentHookEventPayload | null
}

/** Wake the local/remote execution host when a host-owned lease expires without another event. Re-read the pane so closed/moved leftovers are no-ops. */
export class AgentLeaseExpiryTimers {
  private readonly wakeups = new CodexSubagentPollScheduler<PublishRow>(0, (paneKey, publish) =>
    this.restate(paneKey, publish)
  )

  constructor(
    private readonly state: HookListenerState,
    private readonly providers: readonly AgentLeaseExpiryProvider[]
  ) {}

  /** Call whenever a pane's row is stored; `publish` applies the restated row as the host would. */
  arm(paneKey: string, publish: PublishRow): void {
    const entry = this.lease(paneKey)
    if (!entry) {
      this.wakeups.clear(paneKey)
      return
    }
    // Cap delays after backward clock steps; restate rechecks the deadline and may re-arm.
    const delay = Math.min(entry.lease.maxDelayMs, Math.max(0, entry.lease.deadline - Date.now()))
    this.wakeups.schedule(paneKey, publish, delay)
  }

  clearAll(): void {
    this.wakeups.clearAll()
  }

  private lease(paneKey: string) {
    for (const provider of this.providers) {
      const lease = provider.lease(this.state, paneKey)
      if (lease) {
        return { provider, lease }
      }
    }
    return undefined
  }

  private restate(paneKey: string, publish: PublishRow): void {
    const entry = this.lease(paneKey)
    if (!entry) {
      return
    }
    // Why: a timer can fire before the wall clock reaches the deadline the lease is judged by.
    if (entry.lease.deadline > Date.now()) {
      this.arm(paneKey, publish)
      return
    }
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    const settled = row && entry.provider.settle(this.state, paneKey, row)
    if (settled) {
      publish(settled)
    }
  }
}
