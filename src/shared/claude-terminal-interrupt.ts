import { CLAUDE_IDLE, containsAgentSpinnerGlyph } from './agent-title-glyphs'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { AgentStatus } from './agent-title-core'

export type ClaudeTerminalEvidence =
  | { kind: 'input'; data: string }
  | { kind: 'title'; title: string; staleWorkingTitleClear?: boolean }
  /** Claude's OSC 7501 activity; null once it stops reporting. Its titles then carry no glyph. */
  | { kind: 'activity'; status: AgentStatus | null }
  | { kind: 'reset' }

const TITLE_CONFIRMATION_WINDOW_MS = 5_000
// Why shorter: Claude reports idle as Escape lands; a later idle is likelier the turn finishing.
const ACTIVITY_CONFIRMATION_WINDOW_MS = 1_500

// oxlint-disable-next-line no-control-regex -- kitty CSI-u reports the Escape key, not terminal text.
const KITTY_ESCAPE_RE = /^\x1b\[27(?:;1(?::([123]))?)?u$/

function escapeInputEvent(data: string): 'press' | 'repeat' | 'release' | null {
  if (data === '\x1b') {
    return 'press'
  }
  const match = KITTY_ESCAPE_RE.exec(data)
  if (!match) {
    return null
  }
  return match[1] === '3' ? 'release' : match[1] === '2' ? 'repeat' : 'press'
}

type Observation<Row> = {
  working: boolean
  workingRow?: Row
  pending?: { row: Row; at: number }
  /** While Claude reports OSC 7501 activity, that activity, not the title glyph, says working/idle. */
  programReports?: boolean
}

/** Correlates accepted Escape with Claude's live activity (OSC 7501, else title), on the execution host. */
export class ClaudeTerminalInterruptTracker<Row extends AgentHookEventPayload> {
  private readonly observations = new Map<string, Observation<Row>>()

  constructor(
    private readonly readRow: (paneKey: string) => Row | undefined,
    private readonly interrupt: (row: Row) => void
  ) {}

  observe(paneKey: string, evidence: ClaudeTerminalEvidence, now = Date.now()): void {
    if (evidence.kind === 'reset') {
      this.observations.delete(paneKey)
      return
    }
    const row = this.readRow(paneKey)
    if (
      !row ||
      row.payload.agentType !== 'claude' ||
      row.providerSessionOnly ||
      row.restoredUnconfirmed ||
      row.isReplay ||
      row.structuredHost
    ) {
      this.observations.delete(paneKey)
      return
    }
    if (evidence.kind === 'title' && evidence.staleWorkingTitleClear) {
      return
    }
    const observed = this.observations.get(paneKey) ?? { working: false }
    this.observations.set(paneKey, observed)
    if (evidence.kind === 'input') {
      const escape = escapeInputEvent(evidence.data)
      if (escape === 'release' || escape === 'repeat') {
        return
      }
      observed.pending =
        escape === 'press' &&
        observed.working &&
        // Activity is reported only on change, so while it says working the current row is that turn's.
        (observed.programReports === true ||
          observed.workingRow === row ||
          (row.payload.mainAgent?.stateStartedAt !== undefined &&
            observed.workingRow?.payload.mainAgent?.stateStartedAt ===
              row.payload.mainAgent.stateStartedAt &&
            observed.workingRow.providerSession?.id === row.providerSession?.id)) &&
        row.payload.state === 'working' &&
        (row.payload.mainAgent
          ? row.payload.mainAgent.state === 'working'
          : !row.claudeRunningNonAgentTask &&
            !row.payload.subagents?.some((child) => child.state !== 'idle'))
          ? { row, at: now }
          : undefined
      return
    }
    if (evidence.kind === 'activity') {
      observed.programReports = evidence.status !== null
      if (evidence.status !== null) {
        this.settle(
          observed,
          row,
          { working: evidence.status === 'working', idle: evidence.status === 'idle' },
          ACTIVITY_CONFIRMATION_WINDOW_MS,
          now
        )
      }
      return
    }
    if (!observed.programReports) {
      this.settle(
        observed,
        row,
        {
          working: containsAgentSpinnerGlyph(evidence.title),
          idle: evidence.title.trimStart().startsWith(CLAUDE_IDLE)
        },
        TITLE_CONFIRMATION_WINDOW_MS,
        now
      )
    }
  }

  private settle(
    observed: Observation<Row>,
    row: Row,
    { working, idle }: { working: boolean; idle: boolean },
    confirmationWindowMs: number,
    now: number
  ): void {
    observed.working = working
    observed.workingRow = working ? row : undefined
    const pending = observed.pending
    if (!pending) {
      return
    }
    // Continued busy output means Escape left the turn running, as when dismissing /usage.
    if (observed.working || pending.row !== row || now - pending.at > confirmationWindowMs) {
      observed.pending = undefined
      return
    }
    if (idle) {
      observed.pending = undefined
      this.interrupt(row)
    }
  }

  clear(): void {
    this.observations.clear()
  }
}
