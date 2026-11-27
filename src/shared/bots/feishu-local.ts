import { z } from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

export const FEISHU_CLI_MISSING = 'Feishu CLI is not installed on this host'

export const FeishuOpenId = lazyZodSchema(() => z.string().regex(/^ou_[a-zA-Z0-9_-]{1,120}$/))
export const FeishuChatId = lazyZodSchema(() => z.string().regex(/^oc_[a-zA-Z0-9_-]{1,120}$/))
export const FeishuGroupPolicy = lazyZodSchema(() =>
  z.strictObject({
    chatId: FeishuChatId,
    members: z.array(FeishuOpenId).min(1).max(50)
  })
)
export type FeishuGroupPolicy = z.infer<typeof FeishuGroupPolicy>

/** State exposed to the bot owner's setup dialog. CLI credentials stay on the bot's host. */
export type FeishuSetup =
  | { profile: string }
  | { appId: string; appSecret: string; group?: FeishuGroupPolicy }
export type FeishuLocalState = {
  method?: 'cli' | 'sdk'
  profile?: string
  status:
    | 'off'
    | 'credentials-required'
    | 'disconnect-failed'
    | 'upload-permission'
    | 'connecting'
    | 'pairing'
    | 'verification-failed'
    | 'listening'
    | 'cli-missing'
    | 'permission'
    | 'subscription'
    | 'profile-changed'
    | 'retrying'
    | 'paused'
    | 'review'
    | 'expired'
  appId?: string
  groupChatId?: string
  pairingText?: string
}
