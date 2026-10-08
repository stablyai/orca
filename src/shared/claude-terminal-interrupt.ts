import { CLAUDE_IDLE, containsAgentSpinnerGlyph } from './agent-title-glyphs'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'

export type ClaudeTerminalEvidence =
  | { kind: 'input'; data: string }
  | { kind: 'title'; title: string; staleWorkingTitleClear?: boolean }
  | { kind: 'reset' }

const TITLE_CONFIRMATION_WINDOW_MS = 5_000

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
}

/** Correlates accepted Escape with Claude's live OSC title, on the execution host. */
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
        (observed.workingRow === row ||
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
    observed.working = containsAgentSpinnerGlyph(evidence.title)
    observed.workingRow = observed.working ? row : undefined
    const pending = observed.pending
    if (!pending) {
      return
    }
    // Continued busy output means Escape left the turn running, as when dismissing /usage.
    if (
      observed.working ||
      pending.row !== row ||
      now - pending.at > TITLE_CONFIRMATION_WINDOW_MS
    ) {
      observed.pending = undefined
      return
    }
    if (evidence.title.trimStart().startsWith(CLAUDE_IDLE)) {
      observed.pending = undefined
      this.interrupt(row)
    }
  }

  clear(): void {
    this.observations.clear()
  }
}
