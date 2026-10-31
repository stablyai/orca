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
