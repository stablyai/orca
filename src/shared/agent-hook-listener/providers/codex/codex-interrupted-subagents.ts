import type { JsonRecord } from './codex-rollout-jsonl-format'
import { upsertCodexSubagent, type CodexSubagentRoster } from './codex-subagent-roster'
import type {
  CodexSubagentTranscriptState,
  TrackedTranscriptSubagent
} from './codex-subagent-transcript'
import { childTurnState } from './codex-turn-transcript'

// Why: a follow-up's task_started lands just after the parent's interacted item, so a read between
// them sees only the old interrupted turn; keep reading the hidden child this long to show it again.
const RESUMED_TURN_GRACE_MS = 5_000

/** The child this session saw interrupted, as a fresh record a message at `startedAt` resumes. */
export function takeInterruptedCodexSubagent(
  state: CodexSubagentTranscriptState,
  id: string,
  startedAt: number
): TrackedTranscriptSubagent | undefined {
  const tracked = state.subagents.get(id)
  const retired =
    state.interruptedSubagents.get(id) ?? (tracked?.hiddenSince === undefined ? undefined : tracked)
  if (!retired) {
    return undefined
  }
  state.interruptedSubagents.delete(id)
  // Reread from the start: the interrupted turn's end may already sit behind the old cursor.
  return {
    ...retired,
    offset: 0,
    carry: '',
    interrupted: true,
    startedAt,
    unresolvedSince: undefined,
    hiddenSince: undefined
  }
}

/** Whether a hidden child stays unshown after this read; a new turn shows it again. */
export function keepCodexSubagentHidden(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  id: string,
  tracked: TrackedTranscriptSubagent,
  records: JsonRecord[] | undefined,
  now: number
): boolean {
  if (tracked.hiddenSince === undefined) {
    return false
  }
  if (records && childTurnState(records, true) === 'running') {
    tracked.hiddenSince = undefined
    upsertCodexSubagent(
      roster,
      id,
      { description: tracked.description, state: 'working' },
      tracked.startedAt
    )
    return false
  }
  if (now - tracked.hiddenSince >= RESUMED_TURN_GRACE_MS) {
    state.subagents.delete(id)
    state.interruptedSubagents.set(id, tracked)
  }
  return true
}
