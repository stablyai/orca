export type AgentPresenceObservationKind = 'command' | 'evidence'

/** One evidence key's reads within a command. */
type EvidenceClaim = {
  reading: boolean
  /** The last read found the pane owned; while it stays owned a re-check costs no process read. */
  explained: boolean
  misses: number
  missedAtMs: number
  /** Recent sessions this key has reported, so interleaved sessions are not each a "new run". */
  sessionIds: string[]
}

const SEEN_SESSIONS_PER_KEY = 8

/** What a hook says about the agent run behind it; a new run is fresh evidence, never backed off. */
export type AgentRunEvidence = { sessionId?: string; started?: boolean }

/** `started` is the listener's normalized session boundary, never a vendor event name. */
export function agentRunEvidence(event: {
  payload: { sessionBoundary?: boolean }
  providerSession?: { id: string }
}): AgentRunEvidence {
  return { sessionId: event.providerSession?.id, started: event.payload.sessionBoundary === true }
}

/** Records the run on the claim; true when it is one the key has not seen recently. */
function noteAgentRun(claim: EvidenceClaim, run: AgentRunEvidence | undefined): boolean {
  const id = run?.sessionId
  const unseen = Boolean(id && !claim.sessionIds.includes(id))
  if (id && unseen) {
    claim.sessionIds.push(id)
    claim.sessionIds.splice(0, claim.sessionIds.length - SEEN_SESSIONS_PER_KEY)
  }
  return Boolean(run?.started) || unseen
}

type ShellCommand = {
  timer: ReturnType<typeof setTimeout> | null
  claims: Map<string, EvidenceClaim>
  evidenceTimers: Set<ReturnType<typeof setTimeout>>
}

const MISSED_EVIDENCE_RETRY_MS = 5_000
const MISSED_EVIDENCE_RETRY_MAX_MS = 60_000

/** After `misses` reads in a row found nothing, new evidence for that key waits this long. */
export function missedEvidenceRetryMs(misses: number): number {
  return Math.min(MISSED_EVIDENCE_RETRY_MAX_MS, MISSED_EVIDENCE_RETRY_MS * 2 ** (misses - 1))
}

/** One read per shell command, plus reads its evidence buys per key (an agent, or a launch). */
export class AgentPresenceCommandObserver {
  private readonly commands = new Map<string, ShellCommand>()

  constructor(
    private readonly observe: (
      id: string,
      isCurrent: () => boolean,
      kind: AgentPresenceObservationKind,
      /** When the evidence arrived; a process table older than this cannot answer it. */
      evidenceAtMs: number
    ) => Promise<boolean | void>
  ) {}

  /** Repeats inside the pending second coalesce; a start after the read ran is the next command. */
  start(id: string, isCurrent: () => boolean = () => true): void {
    if (this.commands.get(id)?.timer) {
      return
    }
    this.end(id)
    const command = this.open(id)
    const startedAtMs = Date.now()
    const current = () => this.commands.get(id) === command && isCurrent()
    command.timer = setTimeout(() => {
      command.timer = null
      if (current()) {
        void this.observe(id, current, 'command', startedAtMs).catch(() => undefined)
      }
    }, 1_000)
    command.timer.unref?.()
  }

  /**
   * Evidence buys a read for its key unless one is running. A key whose read found the pane owned
   * re-checks on new evidence (no process read while that owner lives, a read once it has gone);
   * a key whose read found nothing waits out a doubling delay, so a hook storm on a pane that can
   * never be captured (tmux) stays a handful of reads. Panes without command marks rely on this,
   * since only a command boundary resets the keys. A new run of the agent (a session start, or a
   * session it has not reported recently) clears that wait, so only repeats of known runs back off.
   */
  evidence(
    id: string,
    key: string,
    isCurrent: () => boolean = () => true,
    delayMs = 0,
    agentRun?: AgentRunEvidence
  ): void {
    const command = this.commands.get(id) ?? this.open(id)
    const existing = command.claims.get(key)
    if (existing && noteAgentRun(existing, agentRun)) {
      existing.misses = 0
    }
    if (
      existing &&
      (existing.reading ||
        (!existing.explained &&
          existing.misses > 0 &&
          Date.now() - existing.missedAtMs < missedEvidenceRetryMs(existing.misses)))
    ) {
      return
    }
    const claim = existing ?? {
      reading: false,
      explained: false,
      misses: 0,
      missedAtMs: 0,
      sessionIds: agentRun?.sessionId ? [agentRun.sessionId] : []
    }
    claim.reading = true
    command.claims.set(key, claim)
    const evidenceAtMs = Date.now()
    const current = () => this.commands.get(id) === command && isCurrent()
    const settle = (explained: boolean | void): void => {
      claim.reading = false
      claim.explained = explained === true
      claim.misses = claim.explained ? 0 : claim.misses + 1
      claim.missedAtMs = Date.now()
    }
    const run = () => {
      if (!current()) {
        settle(false)
        return
      }
      void this.observe(id, current, 'evidence', evidenceAtMs).then(settle, () => settle(false))
    }
    if (delayMs <= 0) {
      run()
      return
    }
    const timer = setTimeout(() => {
      command.evidenceTimers.delete(timer)
      run()
    }, delayMs)
    timer.unref?.()
    command.evidenceTimers.add(timer)
  }

  end(id: string): void {
    const command = this.commands.get(id)
    if (command?.timer) {
      clearTimeout(command.timer)
    }
    for (const timer of command?.evidenceTimers ?? []) {
      clearTimeout(timer)
    }
    this.commands.delete(id)
  }

  stop(): void {
    for (const id of this.commands.keys()) {
      this.end(id)
    }
  }

  private open(id: string): ShellCommand {
    const command: ShellCommand = { timer: null, claims: new Map(), evidenceTimers: new Set() }
    this.commands.set(id, command)
    return command
  }
}
