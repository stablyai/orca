/**
 * The plugin-chrome exemption is a list of exact catalog paths, so it can rot in
 * three directions: a renamed key leaves a dead entry behind, a key that moves
 * into a component the security tests name would widen the exemption silently,
 * and a path that drops out of the list takes every list-driven case with it.
 * These assertions catch all three.
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

  // Why: every other case is driven off the list, so a shrinking list shrinks
  // its own tests and still passes. A count per component is the one check the
  // list cannot satisfy that way, and it does not keep a second copy of it.
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
      PluginSettingsRow: 9
    })
  })
})
