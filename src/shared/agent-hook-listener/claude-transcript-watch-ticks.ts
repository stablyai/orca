// Ticks each armed Claude pane's transcript watch: one second after the pane's last event, then
// every second while armed. Owned by the host that runs the session (main for local panes, the
// relay for SSH and WSL ones), because only that host can read the transcript.
import { CodexSubagentPollScheduler } from '../codex-subagent-poll-scheduler'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import {
  observeClaudeTranscript,
  settleClaudeTranscriptWatch,
  syncClaudeTranscriptCursor,
  type ClaudeTranscriptRow
} from './providers/claude-transcript-watch'

const CLAUDE_TRANSCRIPT_WATCH_MS = 1_000

export type ClaudeTranscriptWatchHost<Context> = {
  state: HookListenerState
  /** Read live, so a tick armed before stop() cannot publish on a downed server. */
  isListening: () => boolean
  /** `context` is what the host last handed `sync` for the pane (the relay's hook envelope). */
  publish: (row: ClaudeTranscriptRow, context: Context | undefined) => void
}

export class ClaudeTranscriptWatch<Context = never> {
  private readonly scheduler: CodexSubagentPollScheduler<Context | undefined>

  constructor(private readonly host: ClaudeTranscriptWatchHost<Context>) {
    this.scheduler = new CodexSubagentPollScheduler(
      CLAUDE_TRANSCRIPT_WATCH_MS,
      (paneKey, context) => this.tick(paneKey, context)
    )
  }

  /** Call with every row the host accepted for a pane: arms or repoints its cursor from that row
   *  and restarts its tick while a cursor exists. */
  sync(accepted: AgentHookEventPayload, context?: Context): void {
    if (syncClaudeTranscriptCursor(this.host.state, accepted)) {
      this.scheduler.schedule(accepted.paneKey, context)
    } else {
      this.scheduler.clear(accepted.paneKey)
    }
  }

  clear(paneKey: string): void {
    this.scheduler.clear(paneKey)
    this.host.state.claudeTranscriptCursorByPaneKey.delete(paneKey)
  }

  clearAll(): void {
    this.scheduler.clearAll()
    this.host.state.claudeTranscriptCursorByPaneKey.clear()
  }

  private tick(paneKey: string, context: Context | undefined): void {
    if (!this.host.isListening()) {
      return
    }
    const observation = observeClaudeTranscript(this.host.state, paneKey)
    if (observation.kind === 'stop') {
      return
    }
    if (observation.row) {
      this.host.publish(observation.row, context)
    }
    // Why after publishing: arming is re-derived from the records the publish left.
    if (settleClaudeTranscriptWatch(this.host.state, paneKey, observation.factApplied)) {
      this.scheduler.schedule(paneKey, context)
    }
  }
}
