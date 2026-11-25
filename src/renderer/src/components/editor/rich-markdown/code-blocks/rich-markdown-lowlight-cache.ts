import type { AutoOptions, createLowlight, LanguageFn, Options } from 'lowlight'

type Lowlight = ReturnType<typeof createLowlight>
type HighlightResult = ReturnType<Lowlight['highlight']>

type HighlightCacheEntry = {
  result: HighlightResult
  sourceCharacters: number
}

type HighlightCacheLimits = {
  maxEntries: number
  maxSourceCharacters: number
}

// Source text bounds retained HASTs; the entry cap also covers empty and tiny blocks.
const DEFAULT_CACHE_LIMITS: HighlightCacheLimits = {
  maxEntries: 256,
  maxSourceCharacters: 128 * 1024
}

function prefixKey(options: Readonly<Options> | null | undefined): string | null {
  return options?.prefix ?? null
}

function highlightKey(
  language: string,
  value: string,
  options: Readonly<Options> | null | undefined
): string {
  return JSON.stringify(['language', language, prefixKey(options), value])
}

function highlightAutoKey(
  value: string,
  options: Readonly<AutoOptions> | null | undefined
): string {
  return JSON.stringify(['auto', prefixKey(options), options?.subset ?? null, value])
}

export function createCachedLowlight(
  lowlight: Lowlight,
  limits: HighlightCacheLimits = DEFAULT_CACHE_LIMITS
): Lowlight {
  const cache = new Map<string, HighlightCacheEntry>()
  let retainedSourceCharacters = 0

  const clear = (): void => {
    cache.clear()
    retainedSourceCharacters = 0
  }

  const getOrHighlight = (
    createKey: () => string,
    sourceCharacters: number,
    highlight: () => HighlightResult
  ): HighlightResult => {
    if (
      limits.maxEntries <= 0 ||
      limits.maxSourceCharacters <= 0 ||
      sourceCharacters > limits.maxSourceCharacters
    ) {
      return highlight()
    }

    const key = createKey()
    const cached = cache.get(key)
    if (cached) {
      cache.delete(key)
      cache.set(key, cached)
      return cached.result
    }
    const result = highlight()
    cache.set(key, { result, sourceCharacters })
    retainedSourceCharacters += sourceCharacters
    while (
      cache.size > limits.maxEntries ||
      retainedSourceCharacters > limits.maxSourceCharacters
    ) {
      const oldest = cache.entries().next()
      if (oldest.done) {
        break
      }
      retainedSourceCharacters -= oldest.value[1].sourceCharacters
      cache.delete(oldest.value[0])
    }
    return result
  }

  const register = ((
    grammarsOrName: Readonly<Record<string, LanguageFn>> | string,
    grammar?: LanguageFn
  ): undefined => {
    clear()
    return typeof grammarsOrName === 'string'
      ? lowlight.register(grammarsOrName, grammar as LanguageFn)
      : lowlight.register(grammarsOrName)
  }) as Lowlight['register']

  const registerAlias = ((
    aliasesOrName: Readonly<Record<string, readonly string[] | string>> | string,
    alias?: readonly string[] | string
  ): undefined => {
    clear()
    return typeof aliasesOrName === 'string'
      ? lowlight.registerAlias(aliasesOrName, alias as readonly string[] | string)
      : lowlight.registerAlias(aliasesOrName)
  }) as Lowlight['registerAlias']

  return {
    ...lowlight,
    highlight: (language, value, options) =>
      getOrHighlight(
        () => highlightKey(language, value, options),
        value.length,
        () => lowlight.highlight(language, value, options)
      ),
    highlightAuto: (value, options) =>
      getOrHighlight(
        () => highlightAutoKey(value, options),
        value.length,
        () => lowlight.highlightAuto(value, options)
      ),
    register,
    registerAlias
  }
}
