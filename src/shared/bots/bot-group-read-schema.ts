import * as z from 'zod'

const Room = z.object({ groupId: z.string().min(1), threadId: z.string().min(1).optional() })
export const BotGroupRead = Room.extend({
  beforeSequence: z.number().int().positive().optional(),
  knownReplyKeys: z
    .array(z.string().length(43))
    .max(40 * 32)
    .optional()
})
export const BotGroupTurnRows = Room.extend({
  operationId: z.string().min(1),
  beforeSequence: z.number().int().positive().optional()
})
