import { z } from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { isSettableBotAvatar, MAX_BOT_AVATAR_BYTES } from '../bot-avatar'
import { requiredString } from './rpc-param-primitives'

/** A mascot, an emoji or null; an upload is set with bots.avatar.upload. */
export const SettableBotAvatar = lazyZodSchema(() =>
  z
    .string()
    .nullable()
    .refine(isSettableBotAvatar, 'Set an uploaded picture with bots.avatar.upload')
)

/** A square PNG, base64, that becomes the bot's picture. */
export const BotAvatarUpload = lazyZodSchema(() =>
  z.object({
    botId: requiredString('Missing bot id'),
    png: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_BOT_AVATAR_BYTES / 3) * 4),
    /** Refused with bot_avatar_changed unless the bot's `avatarRevision` (absent: 0) is still this, checked in
     *  the same step as the write. Sent only to a host with bots.avatar-revision.v3; an older one drops it. */
    expectedAvatarRevision: z.number().int().nonnegative().optional(),
    expectedAvatarEpoch: z.uuid().optional()
  })
)

export const BotAvatarRead = lazyZodSchema(() =>
  z.object({
    botId: requiredString('Missing bot id'),
    /** Return the Generate anchor for this catalog revision instead of reading the PNG. */
    catalogRevision: z.number().int().nonnegative().optional(),
    catalogEpoch: z.uuid().optional()
  })
)

/** Whether a window should draw the bot's Slack icon for `look` (bots.avatar.slackIcon.wanted). */
export const BotSlackIconWanted = lazyZodSchema(() =>
  z.object({
    botId: requiredString('Missing bot id'),
    look: z.string().min(1).max(120)
  })
)

/** A window's 512 px drawing of the bot's mascot in `look`, for its Slack icon. */
export const BotSlackIconUpload = lazyZodSchema(() =>
  BotSlackIconWanted.extend({ png: BotAvatarUpload.shape.png })
)

export type BotAvatarUploadParams = z.infer<typeof BotAvatarUpload>
