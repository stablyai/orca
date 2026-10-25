// Exact nonsecurity chrome exemptions preserve fail-closed protection for new plugin security copy. Never exempt trust badges,
// permission claims, install/trust failures or destructive confirmations; translated reassurance could mislead consent decisions
// (the PluginConsentProvenance extraction exposed this gap). Headings/search/local form copy may be translated.
const TRANSLATABLE_PLUGIN_CHROME = new Set([
  // Plugins pane frame: headings and list states, no claims about behavior.
  'auto.components.settings.PluginsSettingsSection.title',
  'auto.components.settings.PluginsSettingsSection.systemLabel',
  'auto.components.settings.PluginsSettingsSection.install',
  'auto.components.settings.PluginsSettingsSection.loading',
  'auto.components.settings.PluginsSettingsSection.empty',
  'auto.components.settings.PluginsSettingsSection.emptyTitle',
  'auto.components.settings.PluginsSettingsSection.noInstalledResults',
  'auto.components.settings.PluginsSettingsSection.noInstalledResultsTitle',
  // Marketplace browser chrome: refresh, search, and empty states.
  'auto.components.settings.PluginMarketplaceBrowser.manageSources',
  'auto.components.settings.PluginMarketplaceBrowser.addSource',
  'auto.components.settings.PluginMarketplaceBrowser.refresh',
  'auto.components.settings.PluginMarketplaceBrowser.refreshing',
  'auto.components.settings.PluginMarketplaceBrowser.loading',
  'auto.components.settings.PluginMarketplaceBrowser.tryAgain',
  'auto.components.settings.PluginMarketplaceBrowser.clearSearch',
  'auto.components.settings.PluginMarketplaceBrowser.empty',
  'auto.components.settings.PluginMarketplaceBrowser.emptyTitle',
  'auto.components.settings.PluginMarketplaceBrowser.noInstalled',
  'auto.components.settings.PluginMarketplaceBrowser.noInstalledTitle',
  'auto.components.settings.PluginMarketplaceBrowser.noResults',
  'auto.components.settings.PluginMarketplaceBrowser.noResultsTitle',
  'auto.components.settings.PluginMarketplaceBrowser.noSourcesTitle',
  // Local development form: field labels and validation, desktop-only paths.
  'auto.components.settings.PluginDevelopmentSection.title',
  'auto.components.settings.PluginDevelopmentSection.add',
  'auto.components.settings.PluginDevelopmentSection.remove',
  'auto.components.settings.PluginDevelopmentSection.pathLabel',
  'auto.components.settings.PluginDevelopmentSection.pathRequired',
  'auto.components.settings.PluginDevelopmentSection.placeholder',
  // Settings-search index entries: they route to a pane, they do not assert.
  'auto.components.settings.plugins.search.title',
  'auto.components.settings.plugins.search.description',
  'auto.components.settings.plugins.search.install',
  'auto.components.settings.plugins.search.permissions',
  'auto.components.settings.plugins.search.logs',
  'auto.components.settings.plugins.search.development'
])

/** True when a protected-prefix path is plugin chrome a language pack may translate. */
export function translatablePluginChrome(path: string): boolean {
  return TRANSLATABLE_PLUGIN_CHROME.has(path)
}

/** Walk protected containers only when exempt chrome exists below; independently validate every descendant leaf’s full path. */
export function translatablePluginChromeContainer(path: string): boolean {
  const prefix = `${path}.`
  for (const exempt of TRANSLATABLE_PLUGIN_CHROME) {
    if (exempt.startsWith(prefix)) {
      return true
    }
  }
  return false
}

/** The exempt paths, for tests that check the list against the English catalog. */
export function translatablePluginChromePaths(): string[] {
  return [...TRANSLATABLE_PLUGIN_CHROME]
}
