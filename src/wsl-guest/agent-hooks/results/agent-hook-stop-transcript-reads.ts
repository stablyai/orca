import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  droidStopTranscriptPath,
  droidVerdictFields,
  droidVerdictRetryDelayMs,
  readDroidTurnVerdictAsync
} from '../../../shared/agent-hook-listener/providers/droid/droid-turn-outcome'
import { retainClaudeLeadModel } from '../../../shared/agent-hook-listener/providers/claude/lifecycle/claude-roster-state'
import {
  claudeReplyModelChange,
  claudeReplyModelRetryDelayMs,
  claudeStopReplyModelTranscriptPath,
  readClaudeTranscriptReplyModelAsync
} from '../../../shared/agent-hook-listener/providers/claude/transcripts/claude-transcript-reply-model'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import type { AgentHookResultRetryHost } from './agent-hook-result-retry-scheduler'

/** What a Stop's transcript adds to its row, read after the Stop lands. */
type StopTranscriptRead<T> = {
  transcriptPath: (
    source: AgentHookSource,
    original: AgentHookEventPayload,
    body: unknown
  ) => string | undefined
  /** undefined: not written yet, read again; null: nothing to add. */
  read: (transcriptPath: string, owns: () => boolean) => Promise<T | null | undefined>
  retryDelayMs: (attempt: number) => number | undefined
  /** The Stop's row with the find, dated at the Stop; undefined adds nothing. */
  restate: (
    original: AgentHookEventPayload,
    found: T,
    stoppedAt: number
  ) => AgentHookEventPayload | undefined
}

/** Droid appends its turn verdict just after Stop. */
const droidVerdictRead: StopTranscriptRead<'failure' | 'cancellation'> = {
  transcriptPath: droidStopTranscriptPath,
  read: (transcriptPath, owns) => readDroidTurnVerdictAsync(transcriptPath, owns),
  retryDelayMs: droidVerdictRetryDelayMs,
  restate: (original, verdict, stoppedAt) => ({
    ...original,
    payload: { ...original.payload, ...droidVerdictFields(verdict, stoppedAt) }
  })
}

/** Claude hooks name the model only at SessionStart; the Stop's reply names the one /model set. */
function claudeReplyModelRead(host: AgentHookResultRetryHost): StopTranscriptRead<string> {
  return {
    transcriptPath: claudeStopReplyModelTranscriptPath,
    // null (the reply isn't written yet) reads again like nothing found.
    read: async (transcriptPath, owns) =>
      (await readClaudeTranscriptReplyModelAsync(transcriptPath, owns)) ?? undefined,
    retryDelayMs: claudeReplyModelRetryDelayMs,
    restate: (original, reply) => {
      const model = claudeReplyModelChange(original.payload.model, reply)
      if (!model) {
        return undefined
      }
      retainClaudeLeadModel(host.state, original.paneKey, model)
      return { ...original, payload: { ...original.payload, model } }
    }
  }
}

/** Reads one kind of Stop transcript find off the event loop onto that Stop's row. */
class StopTranscriptReader<T> {
  constructor(
    private readonly host: AgentHookResultRetryHost,
    private readonly spec: StopTranscriptRead<T>,
    /** Per-pane timers; a shared map lets the scheduler's clears end these reads too. */
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  ) {}

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }

  schedule(
    source: AgentHookSource,
    body: unknown,
    original: AgentHookEventPayload,
    env?: string,
    version?: string
  ): void {
    const transcriptPath = this.spec.transcriptPath(source, original, body)
    if (!transcriptPath) {
      return
    }
    const paneKey = original.paneKey
    // Dated at the Stop, as on the local path, not when the find lands.
    const stoppedAt = Date.now()
    // Any later row for the pane, even a restated one, ends this Stop's read.
    const owns = () =>
      this.host.isListening() && this.host.state.lastStatusByPaneKey.get(paneKey) === original
    const read = (attempt: number, delayMs: number): void => {
      clearTimeout(this.timers.get(paneKey))
      const timer = setTimeout(() => {
        this.timers.delete(paneKey)
        void this.spec.read(transcriptPath, owns).then((found) => {
          if (!owns()) {
            return
          }
          const retryMs = found === undefined ? this.spec.retryDelayMs(attempt) : undefined
          if (retryMs !== undefined) {
            read(attempt + 1, retryMs)
            return
          }
          const restated = found ? this.spec.restate(original, found, stoppedAt) : undefined
          if (restated) {
            this.host.applyEvent(restated, source, env, version)
          }
        })
      }, delayMs)
      timer.unref?.()
      this.timers.set(paneKey, timer)
    }
    read(1, 0)
  }
}

/** What a Stop's transcript adds after it lands: Droid's turn verdict, Claude's reply model. */
export class AgentHookStopTranscriptReads {
  private readonly readers: {
    schedule: StopTranscriptReader<unknown>['schedule']
    clearAll: () => void
  }[]

  /** Droid shares the scheduler's reply-retry timers; Claude keeps its own, since a Claude Stop
   *  without its text also arms the reply-text retry. */
  constructor(
    host: AgentHookResultRetryHost,
    sharedTimers: Map<string, ReturnType<typeof setTimeout>>
  ) {
    this.readers = [
      new StopTranscriptReader(host, droidVerdictRead, sharedTimers),
      new StopTranscriptReader(host, claudeReplyModelRead(host))
    ]
  }

  schedule(...args: Parameters<StopTranscriptReader<unknown>['schedule']>): void {
    for (const reader of this.readers) {
      reader.schedule(...args)
    }
  }

  clearAll(): void {
    for (const reader of this.readers) {
      reader.clearAll()
    }
  }
}
