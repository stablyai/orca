import { isQualifiedPluginKey } from './plugin-manifest'

/** Consent binds qualified key and fingerprint (capabilities plus trusted worker tier); either trust change requires reapproval. */

export type PluginActivationState = 'approved' | 'pending' | 'disabled'

export type PluginConsentLists = {
  /** Qualified key → consent fingerprint. */
  pluginConsents: Readonly<Record<string, string>>
  disabledPlugins: readonly string[]
}

export function getPluginActivationState(
  qualifiedKey: string,
  currentConsentFingerprint: string,
  lists: PluginConsentLists
): PluginActivationState {
  if (lists.disabledPlugins.includes(qualifiedKey)) {
    return 'disabled'
  }
  return lists.pluginConsents[qualifiedKey] === currentConsentFingerprint ? 'approved' : 'pending'
}

/** Prior consent with changed capabilities needs reapproval rather than first-install prompting. */
export function needsReconsent(
  qualifiedKey: string,
  currentConsentFingerprint: string,
  lists: PluginConsentLists
): boolean {
  const recorded = lists.pluginConsents[qualifiedKey]
  return recorded !== undefined && recorded !== currentConsentFingerprint
}

export function normalizePluginConsents(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const consents: Record<string, string> = {}
  for (const [key, hash] of Object.entries(value)) {
    if (
      typeof hash === 'string' &&
      hash.length > 0 &&
      hash.length <= 256 &&
      isQualifiedPluginKey(key)
    ) {
      consents[key] = hash
    }
  }
  return consents
}

export function normalizePluginIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [
    ...new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.length > 0 && entry.length <= 32 * 1024
      )
    )
  ]
}
