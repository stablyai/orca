export const CHAT_UI_LAUNCH_TIP_MEMBERSHIPS = ['eligible', 'excluded'] as const
export type ChatUiLaunchTipMembership = (typeof CHAT_UI_LAUNCH_TIP_MEMBERSHIPS)[number]

/** Why a profile landed in or out of the audience for the tip announcing Chat UI to everyone. */
export const CHAT_UI_LAUNCH_TIP_AUDIENCE_BASES = [
  /** An existing profile whose new agent launches opened in the terminal. */
  'chat-ui-off',
  /** An existing profile that had already opted into Chat UI. */
  'chat-ui-on',
  'new-profile',
  'unreadable-record'
] as const
export type ChatUiLaunchTipAudienceBasis = (typeof CHAT_UI_LAUNCH_TIP_AUDIENCE_BASES)[number]

/** Fixed from the saved profile on the first load after Chat UI left Experimental, never recomputed from live settings. */
export type ChatUiLaunchTipAudience = {
  version: 1
  membership: ChatUiLaunchTipMembership
  basis: ChatUiLaunchTipAudienceBasis
}

/** Which tip a profile gets: none, the invitation for terminal users, or the note for chat users. */
export type ChatUiLaunchTipVariant = 'none' | 'chat-ui-off' | 'chat-ui-on'

export function chatUiLaunchTipVariant(
  audience: ChatUiLaunchTipAudience | null
): ChatUiLaunchTipVariant {
  if (audience?.membership !== 'eligible') {
    return 'none'
  }
  return audience.basis === 'chat-ui-on' || audience.basis === 'chat-ui-off'
    ? audience.basis
    : 'none'
}

export function parseChatUiLaunchTipAudience(value: unknown): ChatUiLaunchTipAudience | null {
  if (!isRecord(value)) {
    return null
  }
  const membership = CHAT_UI_LAUNCH_TIP_MEMBERSHIPS.find((entry) => entry === value.membership)
  const basis = CHAT_UI_LAUNCH_TIP_AUDIENCE_BASES.find((entry) => entry === value.basis)
  if (value.version !== 1 || membership === undefined || basis === undefined) {
    return null
  }
  return { version: 1, membership, basis }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
