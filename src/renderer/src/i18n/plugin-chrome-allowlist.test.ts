/** Reject dead exemption paths, security-copy keys drifting into the allowlist, and dropped paths. */
import { describe, expect, it } from 'vitest'
import { translatablePluginChromePaths } from '../../../shared/plugins/languages/plugin-translatable-chrome'

// Match the security components pinned by plugin-language-pack-artifact.test.ts.
const SECURITY_COPY_COMPONENTS = [
  'PluginConsentDialog',
  'PluginConsentProvenance',
  'pluginError',
  'PluginKeybindingConsentPreview',
  'PluginMarketplaceListingRow',
  'PluginUpdateAllDialog',
  'PluginMarketplaceSourceDialog',
  'PluginVmRecipeConsentPreview',
  // The inline consent and its copy replaced the review dialog.
  'PluginInstallConsent',
  'PluginPageAction',
  'pluginConsentCopy',
  'pluginInstallAction'
]

describe('translatable plugin chrome', () => {
  it('exempts nothing from a component the security tests pin', () => {
    const leaked = translatablePluginChromePaths().filter((path) =>
      SECURITY_COPY_COMPONENTS.some((component) =>
        path.startsWith(`auto.components.settings.${component}.`)
      )
    )

    expect(leaked).toEqual([])
  })

  // All *Failed copy reports trust decisions, so exclude the entire family from plugin replacement.
  it('exempts no failure copy', () => {
    expect(translatablePluginChromePaths().filter((path) => path.endsWith('Failed'))).toEqual([])
  })

  // List-driven cases shrink with the list; fixed per-component counts catch a dropped path.
  it('exempts a fixed number of paths in each component', () => {
    const counts: Record<string, number> = {}
    for (const path of translatablePluginChromePaths()) {
      const component = path.slice('auto.components.settings.'.length).split('.')[0]
      counts[component] = (counts[component] ?? 0) + 1
    }

    expect(counts).toEqual({
      PluginsSettingsSection: 9,
      PluginMarketplaceBrowser: 14,
      PluginDevelopmentSection: 6,
      plugins: 6,
      PluginInstallDialog: 13,
      PluginSettingsRow: 5
    })
  })
})
