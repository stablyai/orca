import { dirname, basename, join, posix, win32 } from 'node:path'
import { AgentTranscriptPollScheduler } from '../../agent-transcript-poll-scheduler'
import {
  claudeRosterHasRuntimeWorkingSubagent,
  stopClaudeSubagent
} from '../../claude-subagent-roster'
import { stopOwingClaudeAgentTaskNotification } from '../../claude-owed-task-notifications'
import type { HookListenerState } from '../listener-state'
import type { AgentHookEventPayload } from '../listener-event'
import { buildClaudeCachedLeadStatusPayload } from './claude-lifecycle-events'
import { clearClaudePendingWaitForAgent } from './claude-roster-state'
import { claudeRowHasUnlistedLiveWork } from './claude-pane-hold-evidence'
import {
  createClaudeTranscriptCursor,
  clearClaudeTranscriptCursor,
  readClaudeTranscriptChunk,
  type ClaudeTranscriptCursor
} from './claude-transcript-cursor'
import {
  applyClaudeHelperEvidence,
  applyClaudeChildPrompt,
  type ClaudeChildTranscript,
  type ClaudeHelperTranscriptEvidence
} from './claude-helper-transcript-evidence'

type Observation = ClaudeHelperTranscriptEvidence & {
  sessionId: string
  launchToken?: string
  parent: ClaudeTranscriptCursor
  children: Map<string, ClaudeChildTranscript>
  pending?: Promise<void>
}
type Host = {
  current: (paneKey: string) => AgentHookEventPayload | undefined
  publish: (event: AgentHookEventPayload) => void
  listening: () => boolean
}

/** Cursor/evidence lifetime belongs to the execution host; status remains in its existing store. */
export class ClaudeHelperKillPoller {
  private readonly observations = new Map<string, Observation>()
  private readonly scheduler: AgentTranscriptPollScheduler<Observation>

  constructor(
    private readonly state: HookListenerState,
    private readonly host: Host,
    private readonly readChunk = readClaudeTranscriptChunk
  ) {
    this.scheduler = new AgentTranscriptPollScheduler(1_000, (paneKey, entry) => {
      if (this.observations.get(paneKey) !== entry) {
        return
      }
      // The scheduler's synchronous callback must retain the entry across asynchronous file reads.
      this.arm(paneKey, entry)
      void this.poll(paneKey)
    })
  }

  schedule(row: AgentHookEventPayload, receivedAt = Date.now()): void {
    if (
      row.payload.agentType !== 'claude' ||
      row.connectionId !== null ||
      row.providerSessionOnly ||
      row.structuredHost
    ) {
      return
    }
    const path = row.providerSession?.transcriptPath
    const sessionId = row.providerSession?.id
    if (!path || !sessionId || !localTranscriptPath(path)) {
      return
    }
    let entry = this.observations.get(row.paneKey)
    if (!entry || !this.owns(entry, row) || row.payload.sessionBoundary) {
      this.clear(row.paneKey)
      entry = {
        sessionId,
        launchToken: row.launchToken,
        observedAt: Math.min(receivedAt, Date.now()),
        resumedAt: new Map(),
        launches: new Map(),
        parent: createClaudeTranscriptCursor(path),
        children: new Map()
      }
      this.observations.set(row.paneKey, entry)
    }
    this.arm(row.paneKey, entry)
  }

  activate(): void {
    for (const [paneKey, entry] of this.observations) {
      this.arm(paneKey, entry)
    }
  }

  clear(paneKey: string): void {
    this.scheduler.clear(paneKey)
    const entry = this.observations.get(paneKey)
    if (entry) {
      clearClaudeTranscriptCursor(entry.parent)
      for (const child of entry.children.values()) {
        clearClaudeTranscriptCursor(child.cursor)
      }
    }
    this.observations.delete(paneKey)
  }

  clearAll(): void {
    this.scheduler.clearAll()
    for (const entry of this.observations.values()) {
      clearClaudeTranscriptCursor(entry.parent)
      for (const child of entry.children.values()) {
        clearClaudeTranscriptCursor(child.cursor)
      }
    }
    this.observations.clear()
  }

  poll(paneKey: string): Promise<void> {
    const entry = this.observations.get(paneKey)
    if (!entry) {
      return Promise.resolve()
    }
    if (entry.pending) {
      return entry.pending
    }
    entry.pending = this.read(paneKey, entry).finally(() => {
      entry.pending = undefined
      if (this.observations.get(paneKey) === entry) {
        this.arm(paneKey, entry)
      }
    })
    return entry.pending
  }

  private owns(entry: Observation, row: AgentHookEventPayload): boolean {
    return (
      row.payload.agentType === 'claude' &&
      row.connectionId === null &&
      row.providerSession?.id === entry.sessionId &&
      row.providerSession.transcriptPath === entry.parent.path &&
      row.launchToken === entry.launchToken
    )
  }

  private current(paneKey: string, entry: Observation): AgentHookEventPayload | undefined {
    const row = this.host.current(paneKey)
    return this.host.listening() &&
      this.observations.get(paneKey) === entry &&
      row &&
      this.owns(entry, row)
      ? row
      : undefined
  }

  private arm(paneKey: string, entry: Observation): void {
    if (
      this.current(paneKey, entry) &&
      claudeRosterHasRuntimeWorkingSubagent(this.state.claudeSubagentRosterByPaneKey.get(paneKey))
    ) {
      this.scheduler.schedule(paneKey, entry, entry.parent.path)
    } else {
      this.scheduler.clear(paneKey)
    }
  }

  private async read(paneKey: string, entry: Observation): Promise<void> {
    const original = this.current(paneKey, entry)
    if (!original) {
      return
    }
    const current = () => this.current(paneKey, entry) !== undefined
    const parent = await this.readChunk(entry.parent, undefined, {
      current,
      reset: () => {
        entry.killedAt = undefined
        entry.resumedAt.clear()
        entry.launches.clear()
        for (const child of entry.children.values()) {
          clearClaudeTranscriptCursor(child.cursor)
        }
        entry.children.clear()
      },
      consume: (record, progress) => applyClaudeHelperEvidence(entry, record, current, progress)
    })
    if (!parent || !this.current(paneKey, entry)) {
      return
    }
    if (!parent.caughtUp || entry.killedAt === undefined) {
      return
    }
    const killedAt = entry.killedAt
    const roster = this.state.claudeSubagentRosterByPaneKey.get(paneKey)
    if (!roster) {
      return
    }
    const ended: string[] = []
    for (const [id, tracked] of roster) {
      if (
        tracked.state !== 'working' ||
        tracked.restoredFromSnapshot ||
        !/^[\w-]{1,64}$/.test(id)
      ) {
        continue
      }
      let child = entry.children.get(id)
      if (!child) {
        child = {
          cursor: createClaudeTranscriptCursor(
            join(
              dirname(entry.parent.path),
              basename(entry.parent.path, '.jsonl'),
              'subagents',
              `agent-${id}.jsonl`
            )
          )
        }
        entry.children.set(id, child)
      }
      const result = await this.readChunk(child.cursor, undefined, {
        current,
        reset: () => {
          child.promptedAt = undefined
        },
        consume: (record, progress) => applyClaudeChildPrompt(child, record, current, progress)
      })
      if (!this.current(paneKey, entry)) {
        return
      }
      if (!result?.caughtUp || child.promptedAt === undefined) {
        continue
      }
      const generation = Math.max(child.promptedAt, entry.resumedAt.get(id) ?? 0)
      if (generation <= killedAt) {
        ended.push(id)
      }
    }
    const anchor = this.current(paneKey, entry)
    if (!anchor || anchor !== original || !ended.length) {
      return
    }
    // A newer hook can replace the row while I/O waits; retire only its still-present generation.
    const waitOwner = this.state.claudeLeadStateByPaneKey.get(paneKey)?.waitingAgentId
    for (const id of ended) {
      stopClaudeSubagent(roster, id)
      stopOwingClaudeAgentTaskNotification(
        this.state.claudeLaunchedBackgroundTasksByPaneKey.get(paneKey),
        id
      )
    }
    clearClaudePendingWaitForAgent(this.state, paneKey, (id) => ended.includes(id))
    if (!roster.size) {
      this.state.claudeSubagentRosterByPaneKey.delete(paneKey)
    }
    const payload = buildClaudeCachedLeadStatusPayload(
      this.state,
      'SubagentStop',
      paneKey,
      {},
      {
        endedChildWork: true,
        endedRuntimeChildWork: true
      }
    )
    if (!payload) {
      return
    }
    this.host.publish({
      ...anchor,
      payload,
      hasExplicitPrompt: undefined,
      hookEventName: 'SubagentStop',
      toolAgentId: waitOwner && ended.includes(waitOwner) ? waitOwner : ended[0],
      claudeRunningNonAgentTask: claudeRowHasUnlistedLiveWork(this.state, paneKey)
    })
  }
}

function localTranscriptPath(path: string): boolean {
  return process.platform === 'win32'
    ? win32.isAbsolute(path) && !/^[\\/]/.test(path)
    : posix.isAbsolute(path)
}
