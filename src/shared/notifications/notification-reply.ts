import { z } from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

export const NOTIFICATION_REPLY_CATEGORY = 'orca.reply'
export const NOTIFICATION_REPLY_ACTION = 'orca.reply.send'

export const NotificationReplyTargetSchema = lazyZodSchema(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('terminal'),
        terminal: z.string().min(1).max(2048),
        expectedIncarnationId: z.string().min(1).max(2048)
      })
      .strict(),
    z.object({ type: z.literal('chat'), sessionId: z.string().min(1).max(256) }).strict(),
    z.object({ type: z.literal('bot-item'), itemUid: z.string().min(1).max(256) }).strict(),
    z.object({ type: z.literal('group'), groupId: z.string().min(1).max(256) }).strict()
  ])
)

export type NotificationReplyTarget = z.infer<typeof NotificationReplyTargetSchema>

export function notificationReplyFields(
  notification: Record<string, unknown> & { category?: string },
  replyTarget: NotificationReplyTarget | null | undefined
): { category?: typeof NOTIFICATION_REPLY_CATEGORY; replyTarget?: NotificationReplyTarget } {
  if (!replyTarget) {
    return {}
  }
  const fields: {
    replyTarget: NotificationReplyTarget
    category?: typeof NOTIFICATION_REPLY_CATEGORY
  } = {
    replyTarget,
    ...(notification.category ? {} : { category: NOTIFICATION_REPLY_CATEGORY })
  }
  return new TextEncoder().encode(
    JSON.stringify({ ...notification, ...fields, sound: notification.sound ?? false })
  ).byteLength <= 3000
    ? fields
    : {}
}

export function readNotificationReplyTarget(value: unknown): NotificationReplyTarget | null {
  try {
    const parsed = NotificationReplyTargetSchema.safeParse(
      typeof value === 'string' ? JSON.parse(value) : value
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
