/**
 * The plugin-chrome exemption is a list of exact catalog paths, so it can rot in
 * two directions: a renamed key leaves a dead entry behind, and a key that moves
 * into a component the security tests name would widen the exemption silently.
 * These assertions catch both.
 */
import { describe, expect, it } from 'vitest'
import { translatablePluginChromePaths } from '../../../shared/plugins/plugin-translatable-chrome'
import en from './locales/en.json'

// Kept in sync with the components plugin-language-pack-artifact.test.ts pins as
// security copy: nothing from them may appear in the chrome exemption.
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

  // Why: `*Failed` copy reports what happened to a trust decision (a reviewed
  // source that changed, a rollback target that is gone), so the boundary is the
  // whole family rather than a per-message judgement.
  it('exempts no failure copy', () => {
    expect(translatablePluginChromePaths().filter((path) => path.endsWith('Failed'))).toEqual([])
  })
})
