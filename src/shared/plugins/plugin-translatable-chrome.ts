// Why: the protected-translation prefix is deliberately broad so a consent
// surface added tomorrow is covered the day it lands — the lesson from
// PluginConsentProvenance. That breadth also catches copy that carries no
// security meaning at all: section titles, empty states, search affordances,
// and the local development form. A language pack that cannot translate
// "Refresh" leaves the plugins pane half-translated in every locale.
//
// This list is the narrow exception, and it is a list of exact paths rather
// than a pattern on purpose: anything new stays protected until someone
// deliberately adds it here, so the fail-safe survives.
//
// A path belongs here only if rewriting it cannot mislead the person deciding
// whether to trust a plugin. That rules out, and this list therefore omits:
//
//   - trust badges and safety status — `PluginMarketplaceListingRow.official`,
//     `.blocked`, `PluginSettingsRow.blocked`;
//   - promises about what plugins may do — `PluginsSettingsSection.description`
//     ("Plugins run on this computer"), `.systemDescription` ("Nothing runs
//     until you review and enable it"), `.featureOff` ("stays disabled"), and
//     `PluginDevelopmentSection.help` ("Dev plugins still require permission
//     review"). Swapping any of these for reassuring text is the attack;
//   - failure copy that reports a trust event — `installFailed` ("The reviewed
//     source may have changed"). Sibling `*Failed` strings stay protected too,
//     so the boundary is a rule rather than a judgement call per message;
//   - destructive confirmations — `PluginRemoveDialog`, `PluginRollbackDialog`;
//   - every dialog the existing tests already name as security copy.
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
  'auto.components.settings.plugins.search.development',

  // Maturity badge on the pane heading. Says how finished the feature is, not
  // what a plugin may do.
  'auto.components.settings.PluginsSettingsSection.experimental',

  // The install form: tab labels, field labels, placeholders, and the "you
  // left this blank" validation. `gitRefRequired` stays protected — it argues
  // why pinning a ref matters, which is a security claim.
  'auto.components.settings.PluginInstallDialog.cancel',
  'auto.components.settings.PluginInstallDialog.gitLabel',
  'auto.components.settings.PluginInstallDialog.gitPlaceholder',
  'auto.components.settings.PluginInstallDialog.gitTab',
  'auto.components.settings.PluginInstallDialog.gitUrlRequired',
  'auto.components.settings.PluginInstallDialog.install',
  'auto.components.settings.PluginInstallDialog.installing',
  'auto.components.settings.PluginInstallDialog.localLabel',
  'auto.components.settings.PluginInstallDialog.localPlaceholder',
  'auto.components.settings.PluginInstallDialog.localRequired',
  'auto.components.settings.PluginInstallDialog.localTab',
  'auto.components.settings.PluginInstallDialog.source',
  'auto.components.settings.PluginInstallDialog.title',

  // Log affordances and runtime state on an installed row. Trust state stays
  // protected — `blocked`, `bundled`, `dev`, `needsReview`, `invalid`,
  // `viewAdvisory` — as do the enable, remove and rollback actions: those are
  // what the reader weighs when deciding whether this plugin should run.
  'auto.components.settings.PluginSettingsRow.hideLogs',
  'auto.components.settings.PluginSettingsRow.loadingLogs',
  'auto.components.settings.PluginSettingsRow.logCount',
  'auto.components.settings.PluginSettingsRow.moreActions',
  'auto.components.settings.PluginSettingsRow.noLogs',
  'auto.components.settings.PluginSettingsRow.restartCount',
  'auto.components.settings.PluginSettingsRow.restarting',
  'auto.components.settings.PluginSettingsRow.running',
  'auto.components.settings.PluginSettingsRow.viewLogs'
])

/** True when a protected-prefix path is plugin chrome a language pack may translate. */
export function translatablePluginChrome(path: string): boolean {
  return TRANSLATABLE_PLUGIN_CHROME.has(path)
}

/**
 * True when a protected-prefix container holds exempt chrome somewhere below it.
 * The walk rejects a protected path as soon as it sees it, so a container has to
 * stay walkable for its exempt leaves to be reachable — every leaf inside is
 * still checked against its own full path.
 */
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
