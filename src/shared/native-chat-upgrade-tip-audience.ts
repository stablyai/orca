export const NATIVE_CHAT_UPGRADE_TIP_MEMBERSHIPS = ['eligible', 'excluded'] as const
export type NativeChatUpgradeTipMembership = (typeof NATIVE_CHAT_UPGRADE_TIP_MEMBERSHIPS)[number]

/** Why a profile landed in or out of the audience; readers use `nativeChatUpgradeTipVariant`. */
export const NATIVE_CHAT_UPGRADE_TIP_AUDIENCE_BASES = [
  'chat-ui-on',
  'chat-ui-on-unproven',
  /** Chat UI was on with new tabs opening in the terminal; load turned Chat UI off. */
  'chat-ui-on-terminal-default',
  'chat-ui-off',
  'chat-ui-unset',
  'new-profile',
  'unreadable-record'
] as const
export type NativeChatUpgradeTipAudienceBasis =
  (typeof NATIVE_CHAT_UPGRADE_TIP_AUDIENCE_BASES)[number]

/**
 * Whether this profile gets the one-time native chat upgrade tip. Decided once, from the profile
 * as it was saved before this upgrade, and never recomputed from the live Chat UI setting.
 */
export type NativeChatUpgradeTipAudience = {
  version: 1
  membership: NativeChatUpgradeTipMembership
  basis: NativeChatUpgradeTipAudienceBasis
}

/** Which upgrade tip a profile gets: none, the standard tip, or the tip with the chat mode switch. */
export type NativeChatUpgradeTipVariant = 'none' | 'standard' | 'keep-terminal'

export function nativeChatUpgradeTipVariant(
  audience: NativeChatUpgradeTipAudience | null
): NativeChatUpgradeTipVariant {
  if (audience?.membership !== 'eligible') {
    return 'none'
  }
  return audience.basis === 'chat-ui-on-terminal-default' ? 'keep-terminal' : 'standard'
}

/** Whether the profile gets any upgrade tip; null while the variant is still unknown. */
export function isInNativeChatUpgradeTipAudience(
  variant: NativeChatUpgradeTipVariant | null
): boolean | null {
  return variant === null ? null : variant !== 'none'
}

export function createNewProfileNativeChatUpgradeTipAudience(): NativeChatUpgradeTipAudience {
  return { version: 1, membership: 'excluded', basis: 'new-profile' }
}

export function parseNativeChatUpgradeTipAudience(
  value: unknown
): NativeChatUpgradeTipAudience | null {
  if (!isRecord(value)) {
    return null
  }
  const membership = NATIVE_CHAT_UPGRADE_TIP_MEMBERSHIPS.find((entry) => entry === value.membership)
  const basis = NATIVE_CHAT_UPGRADE_TIP_AUDIENCE_BASES.find((entry) => entry === value.basis)
  if (value.version !== 1 || membership === undefined || basis === undefined) {
    return null
  }
  return { version: 1, membership, basis }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
