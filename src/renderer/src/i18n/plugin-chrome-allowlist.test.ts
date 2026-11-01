/** Reject dead exemption paths and security-copy keys that drift into the plugin-chrome allowlist. */
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
})
