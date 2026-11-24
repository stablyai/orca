import { z } from 'zod'
import { MAX_BOT_AVATAR_BYTES } from '../bot-avatar'
import { requiredString } from './rpc-param-primitives'

/** A square PNG, base64, that becomes the bot's picture. */
export const BotAvatarUpload = z.object({
  botId: requiredString('Missing bot id'),
  png: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_BOT_AVATAR_BYTES / 3) * 4),
  /** Refused with bot_avatar_changed unless the bot's `avatarRevision` (absent: 0) is still this, checked in
   *  the same step as the write. Sent only to a host with bots.avatar-revision.v2; an older one drops it. */
  expectedAvatarRevision: z.number().int().nonnegative().optional()
})

export const BotAvatarRead = z.object({
  botId: requiredString('Missing bot id'),
  /** Return the Generate anchor for this catalog revision instead of reading the PNG. */
  catalogRevision: z.number().int().nonnegative().optional()
})

export type BotAvatarUploadParams = z.infer<typeof BotAvatarUpload>
