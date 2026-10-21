import { z } from 'zod'

/** Human-facing Work Inbox: questions an agent explicitly addressed to the human (`orca inbox ask`).
 *  Coordinator mail and dispatch questions never appear here; asking the human is an explicit act. */

/** `answered`: the human answered and the agent has not yet confirmed it; `delivered`: the asking
 *  agent acknowledged the answer (`workInbox.ack`). */
export type WorkInboxStatus = 'open' | 'answered' | 'delivered' | 'cancelled'

export type WorkInboxOption = { id: string; label: string; description?: string }

export type WorkInboxAnswer = { optionId?: string; optionLabel?: string; text?: string }

export type WorkInboxItem = {
  id: string
  /** Bumped on every state change; `answer`/`cancel` must name the revision they acted on. */
  revision: number
  status: WorkInboxStatus
  /** Repo id of the asker's workspace, when it resolved; null for unknown or detached callers. */
  projectId: string | null
  projectLabel: string | null
  worktreeId: string | null
  /** The asker's terminal handle (or Orca session address); stable across one agent's questions. */
  agentId: string
  agentLabel: string
  /** Agent CLI kind from agent status (`claude`, `codex`, ...), when known. */
  agentKind: string | null
  question: string
  options: WorkInboxOption[]
  allowFreeText: boolean
  createdAt: number
  answeredAt?: number
  deliveredAt?: number
  cancelledAt?: number
  answer?: WorkInboxAnswer
}

export const WORK_INBOX_LIST_MAX = 200
export const WORK_INBOX_QUESTION_MAX_LENGTH = 20_000
export const WORK_INBOX_ANSWER_MAX_LENGTH = 20_000
export const WORK_INBOX_OPTIONS_MAX = 20
export const WORK_INBOX_OPTION_MAX_LENGTH = 256

export const WorkInboxListParams = z.object({
  /** Optional exact read for a recent answer outside the bounded history page. */
  id: z.string().min(1).max(256).optional(),
  view: z.enum(['open', 'history']).optional(),
  projectId: z.string().min(1).max(256).optional(),
  agentId: z.string().min(1).max(256).optional(),
  limit: z.number().int().positive().optional()
})
export type WorkInboxListParams = z.infer<typeof WorkInboxListParams>

/** `open` lists `open` items oldest first; `history` lists the rest newest first. */
export type WorkInboxListResult = { items: WorkInboxItem[]; openCount: number }

export const WorkInboxAnswerParams = z
  .object({
    id: z.string().min(1).max(256),
    expectedRevision: z.number().int().nonnegative(),
    /** Idempotency key: a retry with the same key and answer returns `ok` with the same item;
     *  the same key with a different answer is a `conflict`. */
    clientRequestId: z.string().min(1).max(200),
    optionId: z.string().min(1).max(256).optional(),
    text: z.string().max(WORK_INBOX_ANSWER_MAX_LENGTH).optional()
  })
  .refine((params) => params.optionId !== undefined || Boolean(params.text?.trim()), {
    message: 'An answer needs optionId or non-empty text.'
  })
export type WorkInboxAnswerParams = z.infer<typeof WorkInboxAnswerParams>

export const WorkInboxCancelParams = z.object({
  id: z.string().min(1).max(256),
  expectedRevision: z.number().int().nonnegative()
})
export type WorkInboxCancelParams = z.infer<typeof WorkInboxCancelParams>

/** `conflict`: the item moved (another answer, a cancel, or a stale revision); `item` is current. */
export type WorkInboxMutationResult =
  | { status: 'ok'; item: WorkInboxItem }
  | { status: 'conflict'; item: WorkInboxItem }
  | { status: 'not-found' }

export const WorkInboxAskParams = z
  .object({
    from: z.string().min(1).max(256).optional(),
    question: z.string().trim().min(1).max(WORK_INBOX_QUESTION_MAX_LENGTH).optional(),
    /** Comma-separated option labels, as `orchestration ask --options`. */
    options: z
      .string()
      .max(WORK_INBOX_OPTIONS_MAX * (WORK_INBOX_OPTION_MAX_LENGTH + 1))
      .optional(),
    allowFreeText: z.boolean().optional(),
    /** Idempotency key for creation: a retried ask with the same key waits on the same item. */
    requestId: z.string().min(1).max(200).optional(),
    resume: z.string().min(1).max(256).optional(),
    timeoutMs: z.number().int().nonnegative().optional()
  })
  .refine((params) => (params.question ? 1 : 0) + (params.resume ? 1 : 0) === 1, {
    message: 'Choose exactly one of --question or --resume.'
  })
export type WorkInboxAskParams = z.infer<typeof WorkInboxAskParams>

/** The asking agent confirms it received the answer; only the original asker may acknowledge. */
export const WorkInboxAckParams = z.object({
  id: z.string().min(1).max(256),
  from: z.string().min(1).max(256).optional()
})
export type WorkInboxAckParams = z.infer<typeof WorkInboxAckParams>

/** What the asking agent receives. `answer` is set once `status` is `answered` or `delivered`;
 *  the agent then calls `workInbox.ack`, which moves `answered` to `delivered`. */
export type WorkInboxAskResult = {
  message?: string
  id: string
  status: WorkInboxStatus
  answer: WorkInboxAnswer | null
  timedOut: boolean
  cancelled: boolean
  timeoutMs: number
}

export function parseWorkInboxOptionLabels(csv: string | undefined): string[] {
  return (
    csv
      ?.split(',')
      .map((label) => label.trim())
      .filter(Boolean) ?? []
  )
}
