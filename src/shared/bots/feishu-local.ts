export const FEISHU_CLI_MISSING = 'Feishu CLI is not installed on this host'

/** State exposed to the bot owner's setup dialog. CLI credentials stay on the bot's host. */
export type FeishuLocalState = {
  profile?: string
  status:
    | 'off'
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
    // From an older host: review now sits beside the status.
    | 'review'
    | 'expired'
  appId?: string
  pairingText?: string
  /** Messages the owner should look at. `retryable` never reached a chat, so Retry sends them. */
  review?: { count: number; retryable: number }
  /** The native chat the owner's DM is linked to. */
  chat?: { sessionId: string }
  /** How replies reach the DM: cards edited as the turn runs, or a notice and the final answer
   *  while the app lacks a permission (`missing`, when Feishu named it). */
  streaming?: { mode: 'cards' | 'fallback'; missing?: string[] }
}
