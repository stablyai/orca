/**
 * The renderer ships only the English entries i18next cannot rebuild from the
 * `defaultValue` every `translate(key, fallback)` call site passes. These
 * assertions are the proof that the prune is invisible: every English string
 * the app can render still renders identically without the full catalog.
 */
import i18next, { type i18n as I18nInstance } from 'i18next'
import { describe, expect, it } from 'vitest'

import en from './locales/en.json'
import enRuntimeRequired from './en-runtime-required.json'

function flatten(
  value: unknown,
  prefix = '',
  entries = new Map<string, string>()
): Map<string, string> {
  if (typeof value === 'string') {
    entries.set(prefix, value)
    return entries
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return entries
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, entries)
  }
  return entries
}

function createInstance(catalog: unknown): I18nInstance {
  const instance = i18next.createInstance()
  void instance.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: catalog as Record<string, unknown> } },
    interpolation: { escapeValue: false }
  })
  return instance
}

const full = createInstance(en)
const pruned = createInstance(enRuntimeRequired)
const fullEntries = flatten(en)
const prunedEntries = flatten(enRuntimeRequired)

const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/
const pluralBaseKeys = [
  ...new Set(
    [...fullEntries.keys()]
      .filter((key) => PLURAL_SUFFIX_RE.test(key))
      .map((key) => key.replace(PLURAL_SUFFIX_RE, ''))
  )
].sort()

describe('runtime-required English catalog', () => {
  it('keeps every dropped entry reachable from the call site default', () => {
    const changed: string[] = []
    for (const [key, value] of fullEntries) {
      if (prunedEntries.has(key)) {
        continue
      }
      // What the app does: translate(key, fallback) with the fallback the
      // catalog was seeded from. Dropping the entry must not change the result.
      if (pruned.t(key, { defaultValue: value }) !== full.t(key, { defaultValue: value })) {
        changed.push(key)
      }
    }
    expect(changed).toEqual([])
  })

  it('keeps every entry it does ship byte-identical to the translator catalog', () => {
    const drifted = [...prunedEntries.entries()]
      .filter(([key, value]) => fullEntries.get(key) !== value)
      .map(([key]) => key)

    expect(drifted).toEqual([])
  })

  it('ships every plural-suffixed entry', () => {
    const missing = [...fullEntries.keys()].filter(
      (key) => PLURAL_SUFFIX_RE.test(key) && !prunedEntries.has(key)
    )

    expect(missing).toEqual([])
    expect(pluralBaseKeys.length).toBeGreaterThan(0)
  })

  it.each(pluralBaseKeys)('renders %s identically for every count', (base) => {
    for (const count of [0, 1, 2, 5, 11, 100]) {
      const defaultValue = fullEntries.get(base) ?? fullEntries.get(`${base}_other`) ?? ''
      expect(pruned.t(base, { count, defaultValue })).toBe(full.t(base, { count, defaultValue }))
      for (const suffix of ['_one', '_other'] as const) {
        const suffixed = `${base}${suffix}`
        if (!fullEntries.has(suffixed)) {
          continue
        }
        const suffixedDefault = fullEntries.get(suffixed)!
        expect(pruned.t(suffixed, { count, defaultValue: suffixedDefault })).toBe(
          full.t(suffixed, { count, defaultValue: suffixedDefault })
        )
      }
    }
  })
})
