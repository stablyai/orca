import { isProtectedPluginTranslationPath } from './plugin-language-pack-artifact'

/** Packs below this share of translated strings stay installed but can't be chosen as the UI
 *  language, since switching to one would leave most of Orca in English. */
export const PLUGIN_LANGUAGE_PACK_MIN_COVERAGE = 80

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
  english: ReadonlySet<string>
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
