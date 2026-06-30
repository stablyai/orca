import type * as Monaco from 'monaco-editor'
import type { LanguageRegistration } from '@shikijs/types'
import type { IRawGrammar } from 'vscode-textmate'
import { registerTextMateTokensProvider } from './textmate-language-registration'
import { ORCA_SHIKI_LANGUAGE_REGISTRY } from './textmate-shiki-language-registry'
import { SHIKI_LANGUAGE_LOADERS } from './textmate-shiki-language-loaders'
import type { OrcaShikiLanguageRegistration } from './textmate-shiki-language-registry'
import type { ShikiLanguageLoaderMap } from './textmate-shiki-language-loaders'
import type { TextMateGrammarLoader } from './textmate-token-provider'

type MonacoModule = typeof Monaco
type LoadedShikiLanguage = {
  rootScopeName: string
  grammarsByScope: Map<string, IRawGrammar>
  injectionsByScope: Map<string, string[]>
}

export type TextMateGrammarRegistration = {
  languageId: string
  shikiLanguageId: string
  language?: Monaco.languages.ILanguageExtensionPoint
  scopeName: () => Promise<string>
  loadGrammar: TextMateGrammarLoader
  getInjections: (scopeName: string) => string[] | undefined
  source: string
}

export type ShikiLanguageResolver = {
  hasLanguage: (shikiLanguageId: string) => boolean
  loadLanguage: (shikiLanguageId: string) => Promise<LanguageRegistration[]>
}

export { ORCA_SHIKI_LANGUAGE_REGISTRY } from './textmate-shiki-language-registry'
export { SHIKI_LANGUAGE_LOADERS } from './textmate-shiki-language-loaders'
export type { OrcaShikiLanguageRegistration } from './textmate-shiki-language-registry'
export type { ShikiLanguageLoader, ShikiLanguageLoaderMap } from './textmate-shiki-language-loaders'

function unwrapDefault(value: unknown): unknown {
  return value && typeof value === 'object' && 'default' in value
    ? (value as { default: unknown }).default
    : value
}

function isLanguageRegistration(value: unknown): value is LanguageRegistration {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { scopeName?: unknown }).scopeName === 'string'
  )
}

export function normalizeLanguageRegistrations(value: unknown): LanguageRegistration[] {
  const actual = unwrapDefault(value)
  const registrations = Array.isArray(actual) ? actual : [actual]
  return registrations.filter(isLanguageRegistration)
}

export function createShikiLanguageResolver(
  loaders: ShikiLanguageLoaderMap
): ShikiLanguageResolver {
  const loadedLanguages = new Map<string, Promise<LanguageRegistration[]>>()
  const hasLanguage = (shikiLanguageId: string): boolean => Boolean(loaders[shikiLanguageId])

  async function loadLanguage(
    shikiLanguageId: string,
    seen = new Set<string>()
  ): Promise<LanguageRegistration[]> {
    if (seen.has(shikiLanguageId)) {
      return []
    }

    const loadLanguageModule = loaders[shikiLanguageId]
    if (!loadLanguageModule) {
      return []
    }

    const cachedLanguage = loadedLanguages.get(shikiLanguageId)
    if (cachedLanguage) {
      return cachedLanguage
    }

    const loadedLanguage = (async () => {
      const registrations = normalizeLanguageRegistrations(await loadLanguageModule())
      const nextSeen = new Set(seen)
      nextSeen.add(shikiLanguageId)
      const embeddedLanguageIds = Array.from(
        new Set(registrations.flatMap((registration) => registration.embeddedLangsLazy ?? []))
      )
      const embeddedRegistrations = (
        await Promise.all(
          embeddedLanguageIds.map((embeddedLanguageId) =>
            loadLanguage(embeddedLanguageId, nextSeen)
          )
        )
      ).flat()

      return [...embeddedRegistrations, ...registrations]
    })()
    loadedLanguages.set(shikiLanguageId, loadedLanguage)
    return loadedLanguage
  }

  return { hasLanguage, loadLanguage }
}

const defaultShikiLanguageResolver = createShikiLanguageResolver(SHIKI_LANGUAGE_LOADERS)

export function hasShikiLanguage(shikiLanguageId: string): boolean {
  return defaultShikiLanguageResolver.hasLanguage(shikiLanguageId)
}

export function getMissingShikiLanguageMappings(): string[] {
  return ORCA_SHIKI_LANGUAGE_REGISTRY.filter(
    (registration) => !hasShikiLanguage(registration.shikiLanguageId)
  ).map((registration) => registration.shikiLanguageId)
}

function createLoadedShikiLanguage(registrations: LanguageRegistration[]): LoadedShikiLanguage {
  const rootGrammar = registrations.at(-1)
  if (!rootGrammar) {
    throw new Error('Shiki language module did not provide any TextMate grammars')
  }

  const grammarsByScope = new Map<string, IRawGrammar>()
  const injectionsByScope = new Map<string, string[]>()

  for (const grammar of registrations) {
    grammarsByScope.set(grammar.scopeName, grammar as unknown as IRawGrammar)
    for (const scopeName of grammar.injectTo ?? []) {
      const injections = injectionsByScope.get(scopeName) ?? []
      injections.push(grammar.scopeName)
      injectionsByScope.set(scopeName, injections)
    }
  }

  return { rootScopeName: rootGrammar.scopeName, grammarsByScope, injectionsByScope }
}

export function createShikiTextMateGrammarRegistration(
  registration: OrcaShikiLanguageRegistration,
  resolver: ShikiLanguageResolver = defaultShikiLanguageResolver
): TextMateGrammarRegistration | null {
  if (!resolver.hasLanguage(registration.shikiLanguageId)) {
    return null
  }

  let loadedLanguagePromise: Promise<LoadedShikiLanguage> | undefined
  let loadedLanguage: LoadedShikiLanguage | undefined

  async function loadLanguage(): Promise<LoadedShikiLanguage> {
    loadedLanguagePromise ??= resolver.loadLanguage(registration.shikiLanguageId).then((items) => {
      const loaded = createLoadedShikiLanguage(items)
      loadedLanguage = loaded
      return loaded
    })
    return loadedLanguagePromise
  }

  return {
    languageId: registration.monacoLanguageId,
    shikiLanguageId: registration.shikiLanguageId,
    language: registration.language,
    scopeName: async () => (await loadLanguage()).rootScopeName,
    loadGrammar: async (scopeName) => (await loadLanguage()).grammarsByScope.get(scopeName) ?? null,
    getInjections: (scopeName) => loadedLanguage?.injectionsByScope.get(scopeName),
    source: `@shikijs/langs/${registration.shikiLanguageId}`
  }
}

export const TEXTMATE_GRAMMAR_REGISTRY: readonly TextMateGrammarRegistration[] =
  ORCA_SHIKI_LANGUAGE_REGISTRY.flatMap((registration) => {
    const textMateRegistration = createShikiTextMateGrammarRegistration(registration)
    return textMateRegistration ? [textMateRegistration] : []
  })

export const TEXTMATE_GRAMMAR_SOURCES: readonly string[] = Object.keys(SHIKI_LANGUAGE_LOADERS)

function registerLanguageMetadataIfNeeded(
  monaco: MonacoModule,
  language: Monaco.languages.ILanguageExtensionPoint | undefined
): void {
  if (!language) {
    return
  }
  const languageAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((registeredLanguage) => registeredLanguage.id === language.id)
  if (!languageAlreadyRegistered) {
    monaco.languages.register(language)
  }
}

export function registerTextMateGrammarRegistry(monaco: MonacoModule): void {
  for (const registration of TEXTMATE_GRAMMAR_REGISTRY) {
    registerLanguageMetadataIfNeeded(monaco, registration.language)
    registerTextMateTokensProvider(monaco, registration.languageId, {
      getInjections: registration.getInjections,
      scopeName: registration.scopeName,
      loadGrammar: registration.loadGrammar
    })
  }
}
