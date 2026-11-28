import * as z from 'zod'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../agent-session/agent-session-attachments'
import { BotNameSchema } from './bot-record-schemas'
import {
  BotGroupRemoteBotsSchema as RemoteBots,
  BotGroupThreadName as ThreadName,
  BotGroupReplyMode
} from './bot-group-schema'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

const GroupId = lazyZodSchema(() => z.object({ groupId: z.string().min(1) }))
/** A room in the group: one of its threads, or the original room when absent. */
const Room = lazyZodSchema(() => GroupId.extend({ threadId: z.string().min(1).optional() }))
const Revision = lazyZodSchema(() => GroupId.extend({ revision: z.number().int().positive() }))

export const BotGroupCreate = lazyZodSchema(() =>
  z.object({
    name: BotNameSchema,
    botIds: z.array(z.string().min(1)).min(1).max(32),
    remoteBots: RemoteBots.optional()
  })
)

export const BotGroupRead = lazyZodSchema(() =>
  Room.extend({
    beforeSequence: z.number().int().positive().optional()
  })
)

export const BotGroupUpdate = lazyZodSchema(() =>
  Revision.extend({
    name: BotNameSchema.optional(),
    botIds: z.array(z.string().min(1)).min(1).max(32).optional(),
    /** The whole remote roster when present; absent keeps it. */
    remoteBots: RemoteBots.optional(),
    replyMode: BotGroupReplyMode.optional()
  })
)

export const BotGroupReorder = lazyZodSchema(() =>
  GroupId.extend({ sidebarOrder: z.number().int().nonnegative() })
)

export const BotGroupSend = lazyZodSchema(() =>
  Revision.extend({
    threadId: Room.shape.threadId,
    messageId: z.string().uuid(),
    text: z.string().trim().max(100_000),
    images: z
      .array(z.string().min(1).max(4096))
      .max(AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT, 'Group messages take up to 20 images.')
      .optional()
  }).refine(
    (value) => value.text.length > 0 || (value.images?.length ?? 0) > 0,
    'Message text or image is required.'
  )
)

export const BotGroupStop = lazyZodSchema(() =>
  Room.extend({ botId: z.string().min(1).optional() })
)

export const BotGroupNewThread = lazyZodSchema(() => GroupId.extend({}))

/** A thread named by hand. */
export const BotGroupRenameThread = lazyZodSchema(() =>
  Room.required({ threadId: true }).extend({ title: ThreadName })
)

export const BotGroupDelete = GroupId
