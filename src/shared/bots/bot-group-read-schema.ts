import * as z from 'zod'

const Room = z.object({ groupId: z.string().min(1), threadId: z.string().min(1).optional() })
export const BotGroupRead = Room.extend({
  beforeSequence: z.number().int().positive().optional(),
  knownReplyKeys: z
    .array(z.string().length(43))
    .max(40 * 32)
    .optional(),
  updatedPostIds: z.array(z.string().min(1)).max(40).optional(),
  updatesOnly: z.literal(true).optional()
})
export const BotGroupTurnDetailCursorSchema = z.object({
  journal: z
    .tuple([
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
      z.number().int().nonnegative()
    ])
    .optional(),
  worker: z.number().int().positive().optional()
})
export type BotGroupTurnDetailCursor = z.infer<typeof BotGroupTurnDetailCursorSchema>
export const BotGroupTurnRows = Room.extend({
  operationId: z.string().min(1),
  before: BotGroupTurnDetailCursorSchema.optional(),
  requestId: z.string().min(1).max(80).optional(),
  cancel: z.literal(true).optional()
})
