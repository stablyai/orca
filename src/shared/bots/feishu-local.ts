/** State exposed to the bot owner's setup dialog. CLI credentials stay on the bot's host. */
export type FeishuLocalState = {
  profile?: string
  status:
    | 'off'
    | 'connecting'
    | 'pairing'
    | 'verification-failed'
    | 'listening'
    | 'retrying'
    | 'paused'
    | 'review'
    | 'expired'
  pairingText?: string
}
