// Reads each Codex pane's rollout on a timer while it can still change the pane's row, and
// publishes the row rebuilt from what it reads. Owned by the execution host (main for local
// panes, the relay for SSH ones), because only that host can read the rollout.
import { CodexSubagentPollScheduler } from '../codex-subagent-poll-scheduler'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import { codexRolloutNeedsWatch, observeCodexRollout } from './providers/codex-rollout-reader'

const CODEX_ROLLOUT_WATCH_MS = 1_000

export type CodexRolloutWatchHost<Context> = {
  state: HookListenerState
  /** Read live, so a tick armed before stop() cannot publish on a downed server. */
  isListening: () => boolean
  /** `context` is what the host last handed `sync` for the pane (the relay's hook envelope). */
  publish: (observation: AgentHookEventPayload, context: Context | undefined) => void
}

export class CodexRolloutWatch<Context = never> {
  private readonly scheduler: CodexSubagentPollScheduler<Context | undefined>

  constructor(private readonly host: CodexRolloutWatchHost<Context>) {
    this.scheduler = new CodexSubagentPollScheduler(CODEX_ROLLOUT_WATCH_MS, (paneKey, context) =>
      this.tick(paneKey, context)
    )
  }

  /** Arms or disarms the pane from its current records; call after anything changes them. */
  sync(paneKey: string, context?: Context): void {
    if (codexRolloutNeedsWatch(this.host.state, paneKey)) {
      this.scheduler.schedule(paneKey, context)
    } else {
      this.scheduler.clear(paneKey)
    }
  }

  /** Publishes on the next tick whatever the records hold, then keeps watching while needed. */
  arm(paneKey: string, context?: Context): void {
    this.scheduler.schedule(paneKey, context)
  }

  clear(paneKey: string): void {
    this.scheduler.clear(paneKey)
  }

  clearAll(): void {
    this.scheduler.clearAll()
  }

  private tick(paneKey: string, context: Context | undefined): void {
    if (!this.host.isListening()) {
      return
    }
    const observation = observeCodexRollout(this.host.state, paneKey)
    if (observation) {
      this.host.publish(observation, context)
    }
    this.sync(paneKey, context)
  }
}
