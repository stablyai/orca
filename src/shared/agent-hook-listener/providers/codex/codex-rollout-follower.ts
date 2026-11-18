import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { transcriptPollUpdate } from '../../transcript-poll-policy'
import {
  codexApprovalHoldDeadline,
  codexChildAbortDeadline,
  codexRolloutStatus
} from './codex-rollout-status'
import { basename } from 'node:path'
import { getOrCreateCodexRolloutState } from './codex-state'
import { record } from './codex-rollout-jsonl-format'
import { parsePaneKey } from '../../../workspace-layout/stable-pane-id'
import { followCodexChildRollout } from './codex-rollout-state'
import type { RolloutReadLog } from './codex-rollout-async-reads'
import { codexTailQuietUntil } from './codex-rollout-read-plan'
import {
  readCodexChildName,
  readCodexRolloutFile,
  type CodexRolloutReadContext
} from './codex-rollout-file-reads'
import {
  nextCodexSubagentIdentityRetry,
  takeCodexSubagentIdentityReads
} from './codex-subagent-roster'

export type CodexRolloutHookContext = { body: unknown; env?: string; version?: string }

type PaneFollow = CodexRolloutHookContext & {
  /** Current pane key; a pane move re-keys it so reads in flight land on the new pane. */
  key: string
  wake?: ReturnType<typeof setTimeout>
  wakeAt?: number
  /** When a tail read skipped for a recent hook or write is due. */
  tailRetryAt?: number
  /** Last watch event per rollout file name. */
  writes?: Map<string, number>
}

export type CodexRolloutFollowerHost = {
  state: HookListenerState
  env: () => string
  listening: () => boolean
  /** Store a restated row; the host re-arms its tail from what it stored. */
  publish: (update: AgentHookEventPayload, context: CodexRolloutHookContext) => void
  /** Debug sink for slow or timed-out reads; the relay's stdout is a protocol channel. */
  log?: RolloutReadLog
}

/**
 * Hooks own Codex status. This reads only what they lack (child names, approvals reviewer,
 * /review and failed-turn ends, pre-0.150 cancels), always through fs.promises so a slow open
 * delays that one fact and never the event loop. Ordering rules:
 * - one read in flight per file; a request made meanwhile reads again once it lands;
 * - a root read is dropped whole if the turn moved on while it ran (see CodexRolloutState.epoch);
 * - a child's own rollout ends it only if no hook for that child arrived after the read started;
 * - a name read is dropped once its child's session is gone;
 * - a held approval yields only to its own PostToolUse or the turn moving on (CodexApprovalHold);
 * - results publish against the row current when they land, never the row that started them;
 * - a pane move carries reads in flight, holds and the wake timer to the new pane key.
 */
export class CodexRolloutFollower {
  private readonly panes = new Map<string, PaneFollow>()
  private readonly reads: CodexRolloutReadContext

  constructor(private readonly host: CodexRolloutFollowerHost) {
    this.reads = {
      state: host.state,
      log: host.log,
      raiseRead: new WeakMap(),
      publish: (paneKey) => this.publish(paneKey),
      pump: (paneKey, tail) => this.pump(paneKey, tail)
    }
  }

  /** After each stored Codex hook: start the reads it asked for. */
  observe(paneKey: string, context: CodexRolloutHookContext): void {
    const pane = this.panes.get(paneKey)
    if (pane) {
      Object.assign(pane, context)
    } else {
      this.panes.set(paneKey, { ...context, key: paneKey })
    }
    this.pump(paneKey, false)
  }

  /** The directory watch saw this rollout file change. */
  noteWrite(paneKey: string, fileName: string): void {
    const pane = this.panes.get(paneKey)
    if (pane) {
      ;(pane.writes ??= new Map()).set(fileName, Date.now())
    }
  }

  /** A tail tick from the watch-driven scheduler while a root turn is open or children are live. */
  tail(paneKey: string): void {
    this.pump(paneKey, true)
  }

  /** Follow a pane to its new key, keeping reads in flight, held approvals and their timer. */
  move(fromPaneKey: string, toPaneKey: string): void {
    const pane = this.panes.get(fromPaneKey)
    if (!pane || fromPaneKey === toPaneKey) {
      return
    }
    this.clear(toPaneKey)
    this.panes.delete(fromPaneKey)
    if (pane.wake) {
      clearTimeout(pane.wake)
    }
    pane.wake = undefined
    pane.wakeAt = undefined
    pane.key = toPaneKey
    // A rollout-derived Stop is built from this envelope, so it must name the destination pane.
    const envelope = record(pane.body)
    if (envelope) {
      pane.body = {
        ...envelope,
        paneKey: toPaneKey,
        tabId: parsePaneKey(toPaneKey)?.tabId ?? envelope.tabId
      }
    }
    this.panes.set(toPaneKey, pane)
    this.pump(toPaneKey, false)
  }

  clear(paneKey: string): void {
    const pane = this.panes.get(paneKey)
    if (pane?.wake) {
      clearTimeout(pane.wake)
    }
    this.panes.delete(paneKey)
  }

  clearAll(): void {
    for (const pane of this.panes.values()) {
      if (pane.wake) {
        clearTimeout(pane.wake)
      }
    }
    this.panes.clear()
  }

  private pump(paneKey: string, tail: boolean): void {
    const pane = this.panes.get(paneKey)
    if (!pane) {
      return
    }
    const state = this.host.state
    const roster = state.codexSubagentRosterByPaneKey.get(paneKey)
    let rollout = state.codexRolloutByPaneKey.get(paneKey)
    if (tail && roster) {
      for (const [id, child] of roster) {
        if (child.rolloutPath) {
          rollout ??= getOrCreateCodexRolloutState(state, paneKey)
          followCodexChildRollout(rollout, id, child.rolloutPath)
        }
      }
    }
    const now = Date.now()
    let retryAt: number | undefined
    const tailDue = (filePath: string, lastHookAt: number | undefined): boolean => {
      if (!tail) {
        return false
      }
      const until = codexTailQuietUntil(now, lastHookAt, pane.writes?.get(basename(filePath)))
      retryAt = until === undefined || (retryAt ?? Infinity) <= until ? retryAt : until
      return until === undefined
    }
    if (rollout?.root) {
      const due = tailDue(rollout.root.cursor.filePath, rollout.lastRootHookAt)
      if (due || rollout.root.wanted > rollout.root.resolved) {
        readCodexRolloutFile(this.reads, pane, rollout, rollout.root, due)
      }
    }
    for (const file of rollout?.childFiles.values() ?? []) {
      const due =
        file.childId !== undefined &&
        tailDue(file.cursor.filePath, roster?.get(file.childId)?.lastHookAt)
      if (due || file.wanted > file.resolved) {
        readCodexRolloutFile(this.reads, pane, rollout!, file, due)
      }
    }
    if (tail) {
      pane.tailRetryAt = retryAt
    }
    if (roster) {
      for (const { id, filePath } of takeCodexSubagentIdentityReads(roster, Date.now())) {
        readCodexChildName(this.reads, pane, roster, id, filePath)
      }
    }
    this.armWake(paneKey)
  }

  /** One timer per pane, for the next approval-hold deadline or deferred name read. */
  private armWake(paneKey: string): void {
    const pane = this.panes.get(paneKey)
    if (!pane) {
      return
    }
    const state = this.host.state
    const dues = [
      codexApprovalHoldDeadline(state, paneKey),
      codexChildAbortDeadline(state, paneKey),
      pane.tailRetryAt,
      nextCodexSubagentIdentityRetry(state.codexSubagentRosterByPaneKey.get(paneKey))
    ].filter((due): due is number => due !== undefined)
    const wakeAt = dues.length > 0 ? Math.min(...dues) : undefined
    if (pane.wakeAt === wakeAt) {
      return
    }
    if (pane.wake) {
      clearTimeout(pane.wake)
    }
    pane.wake = undefined
    pane.wakeAt = wakeAt
    if (wakeAt === undefined) {
      return
    }
    pane.wake = setTimeout(
      () => {
        pane.wake = undefined
        pane.wakeAt = undefined
        const now = Date.now()
        const abortDue = (codexChildAbortDeadline(this.host.state, paneKey) ?? Infinity) <= now
        const tailDue = (pane.tailRetryAt ?? Infinity) <= now
        this.publish(paneKey)
        // A due abort settles, and a skipped tail reads, only on a fresh read of the rollouts.
        this.pump(paneKey, abortDue || tailDue)
      },
      Math.max(0, wakeAt - Date.now())
    )
    pane.wake.unref?.()
  }

  private publish(paneKey: string): void {
    const pane = this.panes.get(paneKey)
    const current = this.host.state.lastStatusByPaneKey.get(paneKey)
    if (!pane || !this.host.listening() || current?.payload.agentType !== 'codex') {
      return
    }
    const restated = codexRolloutStatus(this.host.state, current, pane.body, this.host.env())
    const update = restated && transcriptPollUpdate('codex', current, restated)
    if (update) {
      this.host.publish(update, pane)
    }
    this.armWake(paneKey)
  }
}
