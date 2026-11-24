// A closed worker prompt's one-line record: its shield and which sentence it reads. Each platform
// words the sentence under its own key, with the tool as `<tool>{{tool}}</tool>` and the worker's
// task as `<task>{{task}}</task>`.
import { approvalRecordTool } from '../../agent-session/requests/prompts/agent-session-approval-tool'
import type { WorkerApprovalPayload } from './worker-approval-payload'

/** An answer either way, a prompt still up in its terminal, or one that closed with none. */
export type WorkerApprovalRecordTone = 'allowed' | 'denied' | 'open' | 'closed'

export type WorkerApprovalRecordSentence =
  | 'youAllowedFor'
  | 'youDeniedFor'
  | 'coordinatorAllowed'
  | 'coordinatorDenied'
  | 'allowedInTerminal'
  | 'deniedInTerminal'
  | 'allowedInChat'
  | 'deniedInChat'
  | 'autoDenied'
  | 'waitsInTerminal'
  | 'workerEnded'
  | 'closedUnnamed'

export type WorkerApprovalRecord = {
  tone: WorkerApprovalRecordTone
  sentence: WorkerApprovalRecordSentence
  tool: string
  /** The line ends with an Open worker link: only its terminal can answer it. */
  opensWorker?: true
  /** The coordinator's reason; `sentAsMessage` when the agent's prompt took none with the answer. */
  reason?: { text: string; sentAsMessage: boolean }
}

/** Who answered a closed worker prompt and how. */
export function workerApprovalRecord(approval: WorkerApprovalPayload): WorkerApprovalRecord {
  const outcome = approval.outcome
  const decision = outcome?.decision ?? null
  const by = outcome?.by
  const allowed = decision === 'allow'
  const answered = (yes: WorkerApprovalRecordSentence, no: WorkerApprovalRecordSentence) =>
    ({ tone: allowed ? 'allowed' : 'denied', sentence: allowed ? yes : no }) as const
  const base = {
    tool: approvalRecordTool(approval.summary.tool, approval.summary.title),
    ...(outcome?.by === 'coordinator' && outcome.reason
      ? {
          reason: {
            text: outcome.reason,
            sentAsMessage: outcome.decision === 'deny' && !outcome.reasonDelivered
          }
        }
      : {})
  }
  switch (decision === null && by !== 'terminal-only' && by !== 'worker-ended' ? 'unknown' : by) {
    case 'person':
      return { ...base, ...answered('youAllowedFor', 'youDeniedFor') }
    case 'coordinator':
      return { ...base, ...answered('coordinatorAllowed', 'coordinatorDenied') }
    case 'worker-terminal':
      return { ...base, ...answered('allowedInTerminal', 'deniedInTerminal') }
    case 'worker-chat':
      return { ...base, ...answered('allowedInChat', 'deniedInChat') }
    case 'auto':
      return { ...base, tone: 'denied', sentence: 'autoDenied' }
    case 'terminal-only':
      return { ...base, tone: 'open', sentence: 'waitsInTerminal', opensWorker: true }
    case 'worker-ended':
      return { ...base, tone: 'closed', sentence: 'workerEnded' }
    case 'unknown':
    case undefined:
      return { ...base, tone: 'closed', sentence: 'closedUnnamed' }
  }
}
