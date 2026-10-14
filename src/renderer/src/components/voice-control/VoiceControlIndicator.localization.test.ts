import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import es from '@/i18n/locales/es.json'
import fr from '@/i18n/locales/fr.json'
import ja from '@/i18n/locales/ja.json'
import ko from '@/i18n/locales/ko.json'
import zh from '@/i18n/locales/zh.json'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveJsonModule types each locale by its own literal keys; the control subtree holds per-module leaf maps plus deeper dotted-path nests, both walked below.
const control = en.auto.components.voice.control as Record<string, unknown>
const translatedLabels = { es, fr, ja, ko, zh }

/** Leaf string maps with their paths: the dotted key formula nests some modules deeper. */
function leafLabelMaps(
  subtree: Record<string, unknown>,
  path: string[] = []
): [string[], Record<string, string>][] {
  const maps: [string[], Record<string, string>][] = []
  for (const [segment, value] of Object.entries(subtree)) {
    if (value && typeof value === 'object') {
      if (Object.values(value).every((leaf) => typeof leaf === 'string')) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the every() above establishes all values are strings.
        maps.push([[...path, segment], value as Record<string, string>])
      } else {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: non-leaf means a deeper nest of the same catalog shape.
        maps.push(...leafLabelMaps(value as Record<string, unknown>, [...path, segment]))
      }
    }
  }
  return maps
}

function getPath(subtree: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = subtree
  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return undefined
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: typeof object check above is the navigation contract for the nested catalog.
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

describe('voice control localization', () => {
  it('uses generated localization keys', () => {
    for (const [, labels] of leafLabelMaps(control)) {
      expect(Object.keys(labels).every((key) => /^[a-f0-9]{10}$/.test(key))).toBe(true)
    }
  })

  it.each(Object.entries(translatedLabels))('translates every label in %s', (_locale, catalog) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same catalog shape as en, asserted leaf by leaf below.
    const localized = catalog.auto.components.voice.control as Record<string, unknown>
    for (const [path, labels] of leafLabelMaps(control)) {
      const localizedLabels = getPath(localized, path)
      for (const [key, englishLabel] of Object.entries(labels)) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: leafLabelMaps only yields string-map leaves; the localized catalogs mirror en's shape.
        const value = (localizedLabels as Record<string, string> | undefined)?.[key]
        expect(value).toBeTruthy()
        expect(value).not.toBe(englishLabel)
      }
    }
  })
})
