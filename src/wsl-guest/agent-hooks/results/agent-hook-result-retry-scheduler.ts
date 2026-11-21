import { hookBodyEnv, hookBodyVersion } from '../publication/agent-hook-envelope-build'
import {
  withHookTranscriptPoll,
  normalizeHookTranscriptPoll,
  type HookTranscriptPollReads
} from '../../../shared/agent-hook-listener/transcripts/hook-transcript-poll-reads'
import { ClaudeHelperKillPoller } from '../../../shared/agent-hook-listener/providers/claude/transcripts/claude-helper-kill-poller'
// Retry late transcript results against the same cached event; one owner cancels both timer families before cache teardown.
import {
  hasPendingAgentResultText,
  preparePendingGrokResultDiscovery
} from '../../../shared/agent-hook-listener/grok-result-discovery'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { pickHostTurnEnd } from '../../../shared/agent-status/contracts/agent-status-types'
import {
  ignoredHookTranscriptPoll,
  museLogOffset,
  nextHookTranscriptPollDelay,
  scheduleHookTranscriptPoll,
  transcriptPollUpdate
} from '../../../shared/agent-hook-listener/transcript-poll-policy'
import { AgentTranscriptPollScheduler } from '../../../shared/agent-hook-listener/transcripts/agent-transcript-poll-scheduler'
import { ClaudeOwedNotificationExpiryTimers } from '../../../shared/agent-hook-listener/providers/claude/background-tasks/claude-owed-notification-expiry-timers'
import { AgentHookDroidVerdictReads } from './agent-hook-droid-verdict-reads'

const ASSISTANT_MESSAGE_RETRY_ATTEMPTS = 5
const ASSISTANT_MESSAGE_RETRY_MS = 50
const CODEX_SUBAGENT_POLL_MS = 1_000

type TranscriptPoll = {
  source: AgentHookSource
  body: unknown
  original: AgentHookEventPayload
  env?: string
  version?: string
  delayMs?: number
}

export type AgentHookResultRetryHost = {
  state: HookListenerState
  env: string
  /** Why: must be read live — a retry armed before stop() must not resurrect on a downed server. */
  isListening: () => boolean
  applyEvent: (
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string
  ) => AgentHookEventPayload | undefined
}

export class AgentHookResultRetryScheduler {
  private generation = 0
  private assistantMessageRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private transcriptPollScheduler: AgentTranscriptPollScheduler<TranscriptPoll>
  private readonly claudeHelperKills: ClaudeHelperKillPoller
  private claudeOwedNotificationExpiry: ClaudeOwedNotificationExpiryTimers
  private readonly droidVerdictReads: AgentHookDroidVerdictReads

  constructor(private readonly host: AgentHookResultRetryHost) {
    this.droidVerdictReads = new AgentHookDroidVerdictReads(host, this.assistantMessageRetryTimers)
    this.claudeHelperKills = new ClaudeHelperKillPoller(host.state, {
      current: (paneKey) => host.state.lastStatusByPaneKey.get(paneKey),
      publish: (event) => {
        host.applyEvent(event, 'claude')
      },
      listening: host.isListening
    })
    this.claudeOwedNotificationExpiry = new ClaudeOwedNotificationExpiryTimers(host.state)
    this.transcriptPollScheduler = new AgentTranscriptPollScheduler(
      CODEX_SUBAGENT_POLL_MS,
      (paneKey, poll, wanted) => this.runTranscriptPoll(paneKey, poll, wanted)
    )
  }

  clearAll(): void {
    this.generation++
    for (const timer of this.assistantMessageRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.assistantMessageRetryTimers.clear()
    this.transcriptPollScheduler.clearAll()
    this.claudeHelperKills.clearAll()
    this.claudeOwedNotificationExpiry.clearAll()
  }

  /** No hook fires when Claude never sends an owed task notification; restate the row ourselves. */
  armClaudeOwedNotificationExpiry(
    source: AgentHookSource,
    paneKey: string,
    env?: string,
    version?: string
  ): void {
    this.claudeOwedNotificationExpiry.arm(paneKey, (row) => {
      if (this.host.isListening()) {
        this.host.applyEvent(row, source, env, version)
      }
    })
  }

  clearAssistantMessageRetry(paneKey: string): void {
    clearTimeout(this.assistantMessageRetryTimers.get(paneKey))
    this.assistantMessageRetryTimers.delete(paneKey)
  }

  scheduleDroidVerdictRead(...args: Parameters<AgentHookDroidVerdictReads['schedule']>): void {
    this.droidVerdictReads.schedule(...args)
  }

  clearTranscriptPoll(paneKey: string): void {
    this.transcriptPollScheduler.clear(paneKey)
    this.claudeHelperKills.clear(paneKey)
  }

  observeClaudeHook(row: AgentHookEventPayload, receivedAt?: number): void {
    this.claudeHelperKills.schedule(row, receivedAt)
  }

  /** Starts work that needs the bound listener; replayed agy panes re-arm their transcript polls. */
  activateListening(replayedAntigravity: ReadonlyMap<string, unknown>): void {
    this.claudeHelperKills.activate()
    for (const body of replayedAntigravity.values()) {
      this.rearmIgnoredHook('antigravity', body)
    }
  }

  scheduleTranscriptPoll(
    source: AgentHookSource,
    body: unknown,
    original: AgentHookEventPayload,
    env?: string,
    version?: string,
    delayMs?: number
  ): void {
    scheduleHookTranscriptPoll(this.transcriptPollScheduler, this.host.state, {
      source,
      body,
      original,
      env,
      version,
      delayMs
    })
  }

  rearmIgnoredHook(source: AgentHookSource, body: unknown): void {
    const poll = ignoredHookTranscriptPoll(this.host.state, source, body, this.host.env, (key) =>
      this.transcriptPollScheduler.peek(key)
    )
    if (poll) {
      this.scheduleTranscriptPoll(
        poll.source,
        poll.body,
        poll.original,
        hookBodyEnv(poll.body),
        hookBodyVersion(poll.body)
      )
    }
  }

  private runTranscriptPoll(
    paneKey: string,
    poll: TranscriptPoll,
    wanted: () => boolean
  ): void | Promise<void> {
    if (!this.ownsTranscriptPoll(paneKey, poll)) {
      return
    }
    if (poll.source !== 'codex' && poll.source !== 'antigravity') {
      this.applyTranscriptPoll(paneKey, poll, undefined)
      return
    }
    // Why: rollout reads stay off the event loop; the next tick waits for this one.
    const generation = this.generation
    const currentOwner = () => {
      const current = this.transcriptPollScheduler.peek(paneKey)
      return current?.source === poll.source && this.ownsTranscriptPoll(paneKey, current)
        ? current
        : undefined
    }
    const live = () => wanted() && this.generation === generation && Boolean(currentOwner())
    return withHookTranscriptPoll(this.host.state, paneKey, poll.source, live, (reads) => {
      const owner = currentOwner()
      if (owner) {
        this.applyTranscriptPoll(paneKey, owner, reads)
      }
    })
  }

  // Newer accepted rows supersede this poll.
  private ownsTranscriptPoll(paneKey: string, { original }: TranscriptPoll): boolean {
    return (
      paneKey === original.paneKey &&
      this.host.isListening() &&
      this.host.state.lastStatusByPaneKey.get(original.paneKey) === original
    )
  }

  private applyTranscriptPoll(
    paneKey: string,
    poll: TranscriptPoll,
    reads: HookTranscriptPollReads | undefined
  ): void {
    const { source, body, original, env, version } = poll
    const logOffset = source === 'muse' ? museLogOffset(this.host.state, paneKey) : undefined
    const event = normalizeHookTranscriptPoll(this.host.state, poll, this.host.env, reads)
    if (!event) {
      return
    }
    const update = transcriptPollUpdate(source, original, event)
    // Why: the next tick's identity check compares against the stored row, not the update it was copied from.
    const next = update ? this.host.applyEvent(update, source, env, version) : original
    if (next) {
      const quiet = !update && museLogOffset(this.host.state, paneKey) === logOffset
      const delayMs = nextHookTranscriptPollDelay(
        this.host.state,
        poll,
        paneKey,
        quiet,
        reads?.antigravity?.nextPoll
      )
      this.scheduleTranscriptPoll(source, body, next, env, version, delayMs)
    }
  }

  scheduleAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: AgentHookEventPayload,
    env?: string,
    version?: string,
    attempt = 1,
    discoveryReady = false
  ): void {
    if (
      original.payload.lastAssistantMessage ||
      !hasPendingAgentResultText(source, body) ||
      attempt > ASSISTANT_MESSAGE_RETRY_ATTEMPTS
    ) {
      return
    }
    this.clearAssistantMessageRetry(original.paneKey)
    if (!discoveryReady) {
      const discovery = preparePendingGrokResultDiscovery(source, body)
      if (discovery) {
        // Why: slug-group discovery can outlive the bounded flush timers, so its completion drives the first retry.
        void discovery
          .then(() => {
            if (this.host.isListening()) {
              this.applyAssistantMessageRetry(source, body, original, env, version, 1, true)
            }
          })
          .catch((err) => {
            process.stderr.write(
              `[relay-hook-server] Grok result discovery failed: ${err instanceof Error ? err.message : String(err)}\n`
            )
          })
        return
      }
    }
    const timer = setTimeout(() => {
      try {
        this.assistantMessageRetryTimers.delete(original.paneKey)
        this.applyAssistantMessageRetry(
          source,
          body,
          original,
          env,
          version,
          attempt + 1,
          discoveryReady
        )
      } catch (err) {
        process.stderr.write(
          `[relay-hook-server] assistant message retry failed: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }, ASSISTANT_MESSAGE_RETRY_MS)
    this.assistantMessageRetryTimers.set(original.paneKey, timer)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  private applyAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: AgentHookEventPayload,
    env: string | undefined,
    version: string | undefined,
    nextAttempt: number,
    requireExactOriginal: boolean
  ): void {
    const current = this.host.state.lastStatusByPaneKey.get(original.paneKey)
    if (
      !current ||
      (requireExactOriginal && current !== original) ||
      current.payload.agentType !== original.payload.agentType ||
      current.payload.prompt !== original.payload.prompt ||
      current.payload.lastAssistantMessage
    ) {
      return
    }
    const event = normalizeHookPayload(this.host.state, source, body, this.host.env)
    if (!event?.payload.lastAssistantMessage) {
      this.scheduleAssistantMessageRetry(
        source,
        body,
        original,
        env,
        version,
        nextAttempt,
        requireExactOriginal
      )
      return
    }
    // Why: the retry only adds text to the same turn end, so it restates that end instead of minting one.
    this.host.applyEvent({ ...event, ...pickHostTurnEnd(current) }, source, env, version)
  }
}
