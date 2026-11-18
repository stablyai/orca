import type { RolloutReadPriority } from './codex-rollout-async-reads'
import type { CodexRolloutFile, CodexRolloutState } from './codex-rollout-state'
import type { CodexSubagentRoster } from './codex-subagent-roster'

// Why: a tail read only finds ends no hook reports (/review, failed turn, aborted child, a cancel
// whose Interrupt hook was lost), and such an end is a rollout's last write, after its last hook.
// Reading a file whose hooks or writes still flow spends a shared read slot, and under a slow open
// a second of one.
const TAIL_QUIET_MS = 1_000

/** Undefined when a tail read may run now; otherwise when it may, once hooks and writes are quiet. */
export function codexTailQuietUntil(
  now: number,
  lastHookAt: number | undefined,
  lastWriteAt: number | undefined
): number | undefined {
  const last = Math.max(lastHookAt ?? 0, lastWriteAt ?? 0)
  return now - last >= TAIL_QUIET_MS ? undefined : last + TAIL_QUIET_MS
}

/** A held approval's read first; a turn-end tail before a speculative reviewer prefetch. */
export function codexRolloutReadPriority(
  rollout: CodexRolloutState,
  roster: CodexSubagentRoster | undefined,
  file: CodexRolloutFile,
  tailDue: boolean
): RolloutReadPriority {
  const path = file.cursor.filePath
  const holds = [
    rollout.rootApprovalHold,
    ...Array.from(roster?.values() ?? [], (child) => child.approvalHold)
  ]
  if (holds.some((hold) => hold?.filePath === path && hold.seq > file.resolved)) {
    return 0
  }
  return tailDue || file.wanted <= file.resolved ? 2 : 3
}
