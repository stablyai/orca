export const NATIVE_CHAT_UPGRADE_TIP_MEMBERSHIPS = ['eligible', 'excluded'] as const
export type NativeChatUpgradeTipMembership = (typeof NATIVE_CHAT_UPGRADE_TIP_MEMBERSHIPS)[number]

/** Why a profile landed in or out of the audience; provenance only, readers use `membership`. */
export const NATIVE_CHAT_UPGRADE_TIP_AUDIENCE_BASES = [
  'chat-ui-on',
  'chat-ui-on-unproven',
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
