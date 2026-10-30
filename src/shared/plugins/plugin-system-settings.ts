/** The plugin system's switches, approvals and dev paths, composed into GlobalSettings. */
export type PluginSystemSettings = {
  /** Master switch for the plugin system. On by default; false means no
   *  discovery, no panels, no plugin code paths run at all. */
  pluginSystemEnabled: boolean
  /** One-shot guard for the default-on rollout: a saved false from the old
   *  default flips on once; later explicit false (e.g. policy) sticks. */
  pluginSystemDefaultedOn?: boolean
  /** Qualified plugin keys (`publisher.id`) the user disabled. Discovered
   *  plugins stay listed but are not activated. */
  disabledPlugins: string[]
  /** Consent records: qualified plugin key → capability/worker-trust fingerprint.
   *  A plugin whose current fingerprint differs is pending again, so an update
   *  crossing either trust boundary re-prompts before code runs. Absent key =
   *  never consented. */
  pluginConsents: Record<string, string>
  /** Local directories loaded as dev-mode plugins (manifest hot-reload). */
  devPluginPaths: string[]
}

type PluginSystemDefaultOnSettings = Pick<
  PluginSystemSettings,
  'pluginSystemEnabled' | 'pluginSystemDefaultedOn'
>

export function normalizePluginSystemEnabledDefaultOn(
  settings: Partial<PluginSystemDefaultOnSettings> | undefined
): Required<PluginSystemDefaultOnSettings> {
  return {
    // Pre-rollout false was the old default, not an opt-out.
    pluginSystemEnabled:
      settings?.pluginSystemDefaultedOn === true ? settings.pluginSystemEnabled !== false : true,
    pluginSystemDefaultedOn: true
  }
}

/** Whether `plugin:<key>/<name>` content comes from a plugin that is switched off. */
export function isPluginContentSwitchedOff(
  settings:
    | Partial<Pick<PluginSystemSettings, 'pluginSystemEnabled' | 'disabledPlugins'>>
    | undefined,
  contentId: string
): boolean {
  if (!contentId.startsWith('plugin:')) {
    return false
  }
  const pluginKey = contentId.slice('plugin:'.length, contentId.lastIndexOf('/'))
  return (
    settings?.pluginSystemEnabled === false ||
    (Array.isArray(settings?.disabledPlugins) && settings.disabledPlugins.includes(pluginKey))
  )
}
