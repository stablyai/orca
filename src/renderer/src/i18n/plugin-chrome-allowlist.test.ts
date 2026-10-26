/** Reject dead exemption paths and security-copy keys that drift into the plugin-chrome allowlist. */
import { describe, expect, it } from 'vitest'
import { translatablePluginChromePaths } from '../../../shared/plugins/plugin-translatable-chrome'
import en from './locales/en.json'

// Match the security components pinned by plugin-language-pack-artifact.test.ts.
const SECURITY_COPY_COMPONENTS = [
  'PluginConsentDialog',
  'PluginConsentProvenance',
  'pluginError',
  'PluginKeybindingConsentPreview',
  'PluginMarketplaceListingRow',
  'PluginMarketplacePreviewDialog',
  'PluginMarketplaceSourceDialog',
  'PluginVmRecipeConsentPreview'
]

function lookup(key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      en as unknown
    )
  return typeof value === 'string' ? value : undefined
}

describe('translatable plugin chrome', () => {
  it.each(translatablePluginChromePaths())('%s still exists in the English catalog', (path) => {
    expect(lookup(path)).toBeTypeOf('string')
  })

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
