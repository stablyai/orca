import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  droidStopTranscriptPath,
  droidVerdictFields,
  droidVerdictRetryDelayMs,
  readDroidTurnVerdictAsync
} from '../../../shared/agent-hook-listener/providers/droid/droid-turn-outcome'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import type { AgentHookResultRetryHost } from './agent-hook-result-retry-scheduler'

/** Droid appends its turn verdict just after Stop; read it off the event loop onto that Stop's row. */
export class AgentHookDroidVerdictReads {
  /** The scheduler's per-pane result retry timers, so its clears end these reads too. */
  constructor(
    private readonly host: AgentHookResultRetryHost,
    private readonly timers: Map<string, ReturnType<typeof setTimeout>>
  ) {}

  schedule(
    source: AgentHookSource,
    body: unknown,
    original: AgentHookEventPayload,
    env?: string,
    version?: string
  ): void {
    const transcriptPath = droidStopTranscriptPath(source, original, body)
    if (!transcriptPath) {
      return
    }
    const paneKey = original.paneKey
    // Dated at the Stop, as on the local path, not when the verdict lands.
    const stoppedAt = Date.now()
    // Any later row for the pane, even a restated one, ends this Stop's read.
    const owns = () =>
      this.host.isListening() && this.host.state.lastStatusByPaneKey.get(paneKey) === original
    const read = (attempt: number, delayMs: number): void => {
      clearTimeout(this.timers.get(paneKey))
      const timer = setTimeout(() => {
        this.timers.delete(paneKey)
        void readDroidTurnVerdictAsync(transcriptPath, owns).then((verdict) => {
          if (!owns()) {
            return
          }
          const retryMs = verdict === undefined ? droidVerdictRetryDelayMs(attempt) : undefined
          if (retryMs !== undefined) {
            read(attempt + 1, retryMs)
          } else if (verdict) {
            const payload = { ...original.payload, ...droidVerdictFields(verdict, stoppedAt) }
            this.host.applyEvent({ ...original, payload }, source, env, version)
          }
        })
      }, delayMs)
      timer.unref?.()
      this.timers.set(paneKey, timer)
    }
    read(1, 0)
  }
}
