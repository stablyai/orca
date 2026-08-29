/**
 * #10770 merged from a base predating #8549, so its stale locale copies
 * overwrote ~185 already-translated strings per locale back to English. A
 * present catalog value always beats the English `translate()` fallback, so
 * those strings render English at runtime with nothing to signal the loss.
 *
 * Later translation passes (#11205 and friends) independently re-covered most of
 * ja/ko/zh, so the re-applied set is only what is still English at HEAD: es 182,
 * zh 55, ja 32, ko 17. The keys sampled below stayed English in all four.
 *
 * These are keys whose English source is UNCHANGED, so an English catalog value
 * can only be a revert. Locale-wide coverage is deliberately not asserted here:
 * genuinely-untranslated new keys are normal, and a blanket gate would fail on
 * every future English-source addition.
 */
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const catalogs = { es, ja, ko, zh }

function lookup(catalog: unknown, key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      catalog
    )
  return typeof value === 'string' ? value : undefined
}

// Sampled across the reverted set: an unconditional sidebar filter row, plugin
// command failures on two surfaces, a settings description, and a status-bar
// metric — so a partial re-revert cannot pass by covering one namespace.
// (workingSetDescription was re-translated upstream for ja/ko; it still guards
// es/zh, and every other key here was English in all four.)
const REVERTED_KEYS = [
  'auto.components.sidebar.SidebarFilter.detachedHead',
  'auto.App.pluginCommandFailed',
  'auto.components.WorktreeJumpPalette.pluginCommandFailed',
  'auto.hooks.useSettingsNavigationMetadata.pluginsDescription',
  'auto.components.status.bar.resource.memory.metric.workingSetDescription',
  'auto.components.settings.EphemeralVmsPane.recipesHelp'
]

describe('locale catalogs reverted by a stale branch base (#10770)', () => {
  it.each(Object.entries(catalogs))('%s translates the reverted keys', (_code, catalog) => {
    for (const key of REVERTED_KEYS) {
      const english = lookup(en, key)
      const localized = lookup(catalog, key)
      expect(english, `${key} missing from en.json`).toBeDefined()
      expect(localized, `${key} missing from catalog`).toBeDefined()
      expect(localized?.trim()).not.toBe('')
      expect(localized, `${key} fell back to the English source`).not.toBe(english)
    }
  })

  // The same stale base regressed English itself: the catalog kept pre-plugins
  // copy while EphemeralVmsPane.tsx already shipped the newer sentence, and a
  // present catalog value wins over the source fallback.
  it('keeps the English catalog in step with its live source string', () => {
    expect(lookup(en, 'auto.components.settings.EphemeralVmsPane.recipesHelp')).toBe(
      'Recipes from orca.yaml and enabled plugins show up here, ready to launch a workspace on.'
    )
  })
})
