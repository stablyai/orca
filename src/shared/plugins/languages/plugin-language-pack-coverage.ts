import { isProtectedPluginTranslationPath } from '../artifacts/plugin-language-pack-artifact'
import { englishSourceEntries, englishSourceFacts } from './plugin-translation-string-policy'

/** Packs below this share of translated strings stay installed but can't be chosen as the UI
 *  language, since switching to one would leave most of Orca in English. */
export const PLUGIN_LANGUAGE_PACK_MIN_COVERAGE = 80

const ENGLISH_BASELINE_PARTITIONS = 4

export function englishBaselinePartition(path: string): number {
  return path.length % ENGLISH_BASELINE_PARTITIONS
}

/** Negative facts are excluded from coverage but still available for string validation. */
export function precomputeEnglishLanguagePackBaseline(catalog: Record<string, unknown>): {
  partitions: Record<string, number>[]
  translatableCount: number
} {
  const partitions = Array.from(
    { length: ENGLISH_BASELINE_PARTITIONS },
    (): Record<string, number> => Object.create(null)
  )
  let translatableCount = 0
  for (const [path, value] of englishSourceEntries(catalog)) {
    const translatable = value.length > 0 && !isProtectedPluginTranslationPath(path)
    const facts = englishSourceFacts(value)
    partitions[englishBaselinePartition(path)][path] = translatable ? facts : -facts - 1
    translatableCount += Number(translatable)
  }
  return { partitions, translatableCount }
}

export type TranslatableCatalogPaths = Pick<ReadonlySet<string>, 'size' | 'has'>

function collectStringPaths(
  catalog: Record<string, unknown>,
  prefix: string,
  into: Set<string>
): Set<string> {
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      if (value.length > 0 && !isProtectedPluginTranslationPath(path)) {
        into.add(path)
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      collectStringPaths(Object.fromEntries(Object.entries(value)), path, into)
    }
  }
  return into
}

/** Dotted paths of every non-empty string a language pack may translate. */
export function translatableCatalogPaths(catalog: Record<string, unknown>): Set<string> {
  return collectStringPaths(catalog, '', new Set())
}

/** Whole percent of `english` paths the pack translates; keys English lacks don't count. */
export function pluginLanguagePackCoverage(
  catalog: Record<string, unknown>,
  english: TranslatableCatalogPaths
): number {
  if (english.size === 0) {
    return 0
  }
  let translated = 0
  for (const path of translatableCatalogPaths(catalog)) {
    if (english.has(path)) {
      translated += 1
    }
  }
  return Math.floor((translated / english.size) * 100)
}

export function isUsablePluginLanguagePack(pack: { coverage: number }): boolean {
  return pack.coverage >= PLUGIN_LANGUAGE_PACK_MIN_COVERAGE
}
