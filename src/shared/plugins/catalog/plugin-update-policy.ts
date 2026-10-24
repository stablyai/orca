/** How catalog plugins update. A union, not a boolean, so later policies (e.g. official only)
 *  can be added without migrating the setting. */
export const PLUGIN_UPDATE_POLICIES = ['auto', 'manual'] as const
export type PluginUpdatePolicy = (typeof PLUGIN_UPDATE_POLICIES)[number]

export type PluginUpdatePolicySettings = {
  /** Absent means `auto`: updates that ask for nothing new install on their own. */
  pluginUpdatePolicy?: PluginUpdatePolicy
}

export function isPluginAutoUpdateOn(settings: PluginUpdatePolicySettings): boolean {
  const policy = settings.pluginUpdatePolicy
  return policy === undefined || policy === 'auto'
}

/** The unvalidated policy key as a settings write or load carries it. */
export type PluginUpdatePolicySettingsInput = { pluginUpdatePolicy?: unknown }

/** Bounds the policy on every write and load; only a key present in `input` returns. */
export function normalizePluginUpdatePolicySettings(
  input: PluginUpdatePolicySettingsInput
): Partial<PluginUpdatePolicySettings> {
  if (!('pluginUpdatePolicy' in input)) {
    return {}
  }
  const value = input.pluginUpdatePolicy
  // Why manual: a policy from a newer Orca is likely stricter, so never widen it to auto.
  return { pluginUpdatePolicy: value === undefined || value === 'auto' ? 'auto' : 'manual' }
}

/** What the last automatic pass did, by plugin key → version. */
export type PluginAutoUpdateState = {
  /** Installed unasked this session. */
  updated: Record<string, string>
  /** Held back because the update asks for more access or moved repository. */
  needsReview: Record<string, string>
}
