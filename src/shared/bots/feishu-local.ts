export const FEISHU_CLI_MISSING = 'Feishu CLI is not installed on this host'

/** State exposed to the bot owner's setup dialog. CLI credentials stay on the bot's host. */
export type FeishuSetup = { profile: string } | { appId: string; appSecret: string }
export type FeishuLocalState = {
  method?: 'cli' | 'sdk'
  profile?: string
  status:
    | 'off'
    | 'credentials-required'
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
  pairingText?: string
}
