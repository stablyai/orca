// Mirror of cloud/packages/connector-contract/src/pr-event-messages.ts for the machine side.
// Copies, not imports: the CLI compiles src/shared with rootDir src, so it can't reach cloud files.
import * as z from 'zod'

export const PR_EVENT_TYPES = [
  'check_failed',
  'check_passed',
  'comment',
  'review_comment',
  'review',
  'merged',
  'closed',
  'reopened'
] as const

/** One event on a pull request this machine's bot owner opened; never a fork's, nor the Orca app's. */
export const PrEvent = z.object({
  key: z.string().min(1),
  type: z.enum(PR_EVENT_TYPES),
  // github:<installation>:<repoId>:<number>, for replies through the connector.
  ref: z.string().min(1),
  repo: z.object({ id: z.string().min(1), fullName: z.string().min(1) }),
  number: z.number().int().positive(),
  headRef: z.string().min(1),
  headSha: z.string().min(1),
  actor: z.string().min(1).optional(),
  // The pull request's author did it: on a worker's pull request, maybe the worker itself.
  fromAuthor: z.literal(true).optional(),
  check: z.string().min(1).optional(),
  reviewState: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  text: z.string().optional(),
  occurredAt: z.number().int().nonnegative()
})
export type PrEvent = z.infer<typeof PrEvent>
