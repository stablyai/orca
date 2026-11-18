/** Codes sharing a bot throws, which the owner's dialogs map to their own words. */
export const BOT_SHARE_ERRORS = {
  blocked: 'bot_share_secret_found',
  noteSecret: 'bot_share_note_secret',
  expired: 'bot_share_preview_expired',
  prepareAgain: 'bot_share_prepare_again',
  stopped: 'bot_share_link_stopped',
  moved: 'bot_share_link_moved',
  /** The Orca Cloud this app talks to has bot sharing turned off. */
  unavailable: 'bot_share_unavailable',
  /** Orca Cloud refused the bot's picture. */
  avatarRefused: 'bot_share_avatar_refused',
  /** Over Orca Cloud's package size limits or the account's storage. */
  tooLarge: 'bot_share_too_large',
  /** Signed out of Orca. */
  signIn: 'bot_share_sign_in',
  /** The Orca sign-in needs renewing. */
  reconnect: 'bot_share_reconnect'
} as const

export type BotShareErrorCode = (typeof BOT_SHARE_ERRORS)[keyof typeof BOT_SHARE_ERRORS]
