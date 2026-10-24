/** The plugin system's switches, approvals and dev paths, composed into GlobalSettings. */
export type PluginSystemSettings = {
  /** Master switch for the experimental plugin system. Off by default: no
   *  discovery, no panels, no plugin code paths run at all. */
  pluginSystemEnabled: boolean
  /** Second opt-in for trusted-worker plugins (unsandboxed Node). Off by default. */
  pluginFullAccessEnabled: boolean
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
