import { CodexSubagentPollScheduler } from '../../agent-hook-listener/transcripts/codex-subagent-poll-scheduler'
import type { AgentProcessVerdict } from './agent-process-presence'

const AGENT_EXIT_WATCH_FIRST_PROBE_MS = 250
const AGENT_EXIT_WATCH_MAX_PROBE_MS = 8_000
const AGENT_EXIT_WATCH_WINDOW_MS = 90_000

export type AgentExitWatchHost = {
  /** False once the pane no longer holds what the watch was started for. */
  isCurrent: () => boolean
  /** One liveness check; `exited` must already have ended the row, `null` means nothing to check. */
  probe: () => Promise<AgentProcessVerdict | null>
}

type Watch = AgentExitWatchHost & { delayMs: number; deadline: number }

/** Asks the process itself whether an agent that announced its end exited; a `/clear` also ends a session. */
export class AgentProcessExitWatch {
  private readonly watches = new Map<string, Watch>()
  private readonly wakeups = new CodexSubagentPollScheduler<Watch>(
    AGENT_EXIT_WATCH_FIRST_PROBE_MS,
    (key, watch) => this.probe(key, watch)
  )

  start(key: string, host: AgentExitWatchHost): void {
    const watch: Watch = {
      ...host,
      delayMs: AGENT_EXIT_WATCH_FIRST_PROBE_MS,
      deadline: performance.now() + AGENT_EXIT_WATCH_WINDOW_MS
    }
    this.watches.set(key, watch)
    this.wakeups.schedule(key, watch)
  }

  stop(key: string): void {
    this.watches.delete(key)
    this.wakeups.clear(key)
  }

  stopAll(): void {
    this.watches.clear()
    this.wakeups.clearAll()
  }

  private probe(key: string, watch: Watch): void {
    if (
      this.watches.get(key) !== watch ||
      !watch.isCurrent() ||
      performance.now() >= watch.deadline
    ) {
      this.watches.delete(key)
      return
    }
    void watch.probe().then(
      (verdict) => {
        const next = Math.min(watch.delayMs * 2, AGENT_EXIT_WATCH_MAX_PROBE_MS)
        // Why: a probe that settles after stop() or a restart belongs to a watch nobody holds.
        if (
          this.watches.get(key) !== watch ||
          verdict === 'exited' ||
          verdict === null ||
          performance.now() + next > watch.deadline
        ) {
          if (this.watches.get(key) === watch) {
            this.watches.delete(key)
          }
          return
        }
        watch.delayMs = next
        this.wakeups.schedule(key, watch, next)
      },
      () => {
        if (this.watches.get(key) === watch) {
          this.watches.delete(key)
        }
      }
    )
  }
}
