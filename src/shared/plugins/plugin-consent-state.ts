import { isQualifiedPluginKey } from './plugin-manifest'

/**
 * Consent + enablement state derivation. Consent is recorded against the
 * (qualified plugin key → consent fingerprint) pair, never the bare id. The
 * fingerprint covers capabilities and the trusted-worker execution tier, so
 * crossing either trust boundary requires approval before plugin code runs.
 */

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

/** True when the plugin was consented before but its capability set changed —
 *  the UI shows "needs re-approval" instead of a first-install prompt. */
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
