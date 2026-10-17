/**
 * Canonical form of the locale a plugin language pack declares.
 *
 * The manifest accepts any string here, so a pack can ship `ru_RU`, `RU-ru`,
 * `not_a_locale`, or `xx`. Every `Intl` consumer needs the same two guarantees
 * before it can trust that value: a tag `Intl` will not reject outright, and a
 * decision that never lets a malformed tag reach the runtime, where an unknown
 * one silently resolves to the host machine's locale.
 *
 * Canonicalizing here — once — keeps date formatting and plural selection
 * agreeing on what a pack declared. Whether the tag is actually *supported* is
 * left to each caller, because `Intl.DateTimeFormat` and `Intl.PluralRules`
 * carry different data.
 */
// Why: getIntlLocale() runs on render paths, and Intl.getCanonicalLocales costs
// about as much as the supportedLocalesOf call it precedes (~1.6µs here), so
// resolving on every call would double that work. Keys come from installed
// manifests, so the map holds a handful of entries for the process lifetime.
const canonicalByDeclared = new Map<string, string | undefined>()

export function canonicalizePackLocale(declared: string): string | undefined {
  if (canonicalByDeclared.has(declared)) {
    return canonicalByDeclared.get(declared)
  }
  const canonical = resolveCanonicalPackLocale(declared)
  canonicalByDeclared.set(declared, canonical)
  return canonical
}

function resolveCanonicalPackLocale(declared: string): string | undefined {
  // POSIX-style tags are a common manifest slip; Intl only accepts dashes.
  const candidate = declared.trim().replace(/_/g, '-')
  if (!candidate) {
    return undefined
  }
  try {
    return Intl.getCanonicalLocales(candidate)[0]
  } catch {
    return undefined
  }
}
