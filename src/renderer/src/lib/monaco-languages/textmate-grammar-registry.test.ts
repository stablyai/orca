import { describe, expect, it, vi } from 'vitest'
import type { LanguageRegistration } from '@shikijs/types'
import {
  createShikiLanguageResolver,
  createShikiTextMateGrammarRegistration,
  getMissingShikiLanguageMappings,
  normalizeLanguageRegistrations,
  ORCA_SHIKI_LANGUAGE_REGISTRY,
  registerTextMateGrammarRegistry,
  SHIKI_LANGUAGE_LOADERS,
  TEXTMATE_GRAMMAR_REGISTRY
} from './textmate-grammar-registry'
import type { ShikiLanguageLoader, ShikiLanguageLoaderMap } from './textmate-grammar-registry'
import type { TextMateGrammarLoader } from './textmate-token-provider'

function createMonacoMock(registeredLanguages: { id: string }[] = []) {
  const languages = [...registeredLanguages]
  const factories = new Map<string, { create: () => unknown }>()
  const monaco = {
    languages: {
      getLanguages: vi.fn(() => languages),
      register: vi.fn((language: { id: string }) => {
        languages.push({ id: language.id })
      }),
      registerTokensProviderFactory: vi.fn(
        (languageId: string, factory: { create: () => unknown }) => {
          factories.set(languageId, factory)
          return { dispose: vi.fn() }
        }
      )
    }
  }

  return { monaco, factories }
}

function grammar(
  scopeName: string,
  options: Pick<LanguageRegistration, 'embeddedLangsLazy' | 'injectTo'> = {}
): LanguageRegistration {
  return { name: scopeName, scopeName, patterns: [], repository: {}, ...options }
}

function languageLoader(...registrations: LanguageRegistration[]): ShikiLanguageLoader {
  return vi.fn(async () => ({ default: registrations }))
}

const expectedRegisteredLanguageIds = [
  'typescript',
  'javascript',
  'json',
  'markdown',
  'mermaid',
  'css',
  'scss',
  'less',
  'html',
  'xml',
  'python',
  'rust',
  'go',
  'java',
  'kotlin',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'php',
  'swift',
  'shell',
  'bat',
  'powershell',
  'yaml',
  'ini',
  'toml',
  'sql',
  'graphql',
  'dockerfile',
  'protobuf',
  'lua',
  'r',
  'scala',
  'dart',
  'elixir',
  'erlang',
  'haskell',
  'clojure',
  'vue',
  'svelte',
  'astro',
  'systemverilog',
  'verilog',
  'nim',
  'hcl',
  'csv',
  'tsv',
  'makefile',
  'cmake'
]

describe('TEXTMATE_GRAMMAR_REGISTRY', () => {
  it('maps Orca-detected language ids to explicit Shiki language loaders', () => {
    expect(getMissingShikiLanguageMappings()).toEqual([])
    expect(TEXTMATE_GRAMMAR_REGISTRY.map((registration) => registration.languageId)).toEqual(
      expectedRegisteredLanguageIds
    )
    expect(
      ORCA_SHIKI_LANGUAGE_REGISTRY.map((registration) => registration.monacoLanguageId)
    ).not.toContain('notebook')
    expect(TEXTMATE_GRAMMAR_REGISTRY.map((registration) => registration.source)).toEqual(
      expect.arrayContaining(['@shikijs/langs/tsx', '@shikijs/langs/markdown'])
    )
    expect(TEXTMATE_GRAMMAR_REGISTRY.map((registration) => registration.source)).not.toEqual(
      expect.arrayContaining([expect.stringContaining(`shiki/${'langs'}`)])
    )
  })

  it('keeps support loaders explicit without registering extra Monaco providers', () => {
    expect(Object.keys(SHIKI_LANGUAGE_LOADERS)).toEqual(
      expect.arrayContaining(['javascript', 'typescript', 'json', 'postcss', 'pug'])
    )

    const shikiIds = TEXTMATE_GRAMMAR_REGISTRY.map((registration) => registration.shikiLanguageId)
    for (const id of ['javascript', 'typescript', 'postcss', 'pug']) {
      expect(shikiIds).not.toContain(id)
    }
  })

  it('registers Monaco token provider factories and missing language metadata', () => {
    const { monaco, factories } = createMonacoMock([{ id: 'typescript' }])

    registerTextMateGrammarRegistry(monaco as never)

    expect([...factories.keys()]).toEqual(expectedRegisteredLanguageIds)
    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: 'mermaid',
      extensions: ['.mmd', '.mermaid'],
      aliases: ['Mermaid']
    })
    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: 'toml',
      extensions: ['.toml'],
      aliases: ['TOML']
    })
    expect(monaco.languages.register).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'typescript' })
    )
  })

  it('does not load grammars while registering provider factories', () => {
    const restoredRegistrations: (() => void)[] = []

    try {
      for (const registration of TEXTMATE_GRAMMAR_REGISTRY) {
        const originalLoadGrammar = registration.loadGrammar
        const originalScopeName = registration.scopeName
        const loadGrammar = vi.fn(originalLoadGrammar)
        const scopeName = vi.fn(originalScopeName)
        ;(registration as { loadGrammar: TextMateGrammarLoader }).loadGrammar = loadGrammar
        ;(registration as { scopeName: () => Promise<string> }).scopeName = scopeName
        restoredRegistrations.push(() => {
          ;(registration as { loadGrammar: TextMateGrammarLoader }).loadGrammar =
            originalLoadGrammar
          ;(registration as { scopeName: () => Promise<string> }).scopeName = originalScopeName
        })
      }

      const { monaco } = createMonacoMock()
      registerTextMateGrammarRegistry(monaco as never)

      for (const registration of TEXTMATE_GRAMMAR_REGISTRY) {
        expect(registration.loadGrammar).not.toHaveBeenCalled()
        expect(registration.scopeName).not.toHaveBeenCalled()
      }
    } finally {
      for (const restore of restoredRegistrations) {
        restore()
      }
    }
  })

  it('loads root grammar metadata for a known Shiki language', async () => {
    const registration = TEXTMATE_GRAMMAR_REGISTRY.find((item) => item.languageId === 'typescript')
    expect(registration).toBeDefined()

    const rootScopeName = await registration!.scopeName()

    expect(rootScopeName).toBe('source.tsx')
    await expect(registration!.loadGrammar(rootScopeName)).resolves.toMatchObject({
      scopeName: 'source.tsx'
    })
  })

  it('loads embedded grammars from Shiki language modules', async () => {
    const registration = TEXTMATE_GRAMMAR_REGISTRY.find((item) => item.languageId === 'html')
    expect(registration).toBeDefined()

    await registration!.scopeName()

    await expect(registration!.loadGrammar('source.js')).resolves.toMatchObject({
      scopeName: 'source.js'
    })
    await expect(registration!.loadGrammar('source.css')).resolves.toMatchObject({
      scopeName: 'source.css'
    })
  })

  it('loads supported lazy embedded grammars for Markdown and SFC languages', async () => {
    const markdown = TEXTMATE_GRAMMAR_REGISTRY.find((item) => item.languageId === 'markdown')
    const vue = TEXTMATE_GRAMMAR_REGISTRY.find((item) => item.languageId === 'vue')
    const svelte = TEXTMATE_GRAMMAR_REGISTRY.find((item) => item.languageId === 'svelte')
    const astro = TEXTMATE_GRAMMAR_REGISTRY.find((item) => item.languageId === 'astro')
    expect(markdown).toBeDefined()
    expect(vue).toBeDefined()
    expect(svelte).toBeDefined()
    expect(astro).toBeDefined()

    await markdown!.scopeName()
    await vue!.scopeName()
    await svelte!.scopeName()
    await astro!.scopeName()

    await expect(markdown!.loadGrammar('source.js')).resolves.toMatchObject({
      scopeName: 'source.js'
    })
    await expect(markdown!.loadGrammar('source.ts')).resolves.toMatchObject({
      scopeName: 'source.ts'
    })
    await expect(vue!.loadGrammar('source.tsx')).resolves.toMatchObject({ scopeName: 'source.tsx' })
    await expect(svelte!.loadGrammar('text.html.markdown')).resolves.toMatchObject({
      scopeName: 'text.html.markdown'
    })
    await expect(astro!.loadGrammar('source.css.scss')).resolves.toMatchObject({
      scopeName: 'source.css.scss'
    })
    expect(vue!.getInjections('source.vue')).toEqual(
      expect.arrayContaining(['vue.directives', 'vue.interpolations'])
    )
  })

  it('returns null for unknown scopes', async () => {
    const registration = TEXTMATE_GRAMMAR_REGISTRY.find((item) => item.languageId === 'typescript')
    expect(registration).toBeDefined()

    await expect(registration!.loadGrammar('source.unknown')).resolves.toBeNull()
  })

  it('skips unknown Shiki language mappings safely', () => {
    expect(
      createShikiTextMateGrammarRegistration({
        monacoLanguageId: 'unknown',
        shikiLanguageId: 'missing-shiki-language'
      })
    ).toBeNull()
  })

  it('normalizes Shiki language module exports', () => {
    const item = grammar('source.test')

    expect(normalizeLanguageRegistrations({ default: item })).toEqual([item])
    expect(normalizeLanguageRegistrations({ default: [item] })).toEqual([item])
    expect(normalizeLanguageRegistrations({ default: [null, item] })).toEqual([item])
  })
})

describe('createShikiLanguageResolver', () => {
  it('recursively loads supported lazy embedded languages before the root grammar', async () => {
    const loaders: ShikiLanguageLoaderMap = {
      parent: languageLoader(grammar('source.parent', { embeddedLangsLazy: ['child'] })),
      child: languageLoader(grammar('source.child', { embeddedLangsLazy: ['grandchild'] })),
      grandchild: languageLoader(grammar('source.grandchild'))
    }
    const resolver = createShikiLanguageResolver(loaders)

    await expect(resolver.loadLanguage('parent')).resolves.toMatchObject([
      { scopeName: 'source.grandchild' },
      { scopeName: 'source.child' },
      { scopeName: 'source.parent' }
    ])
    expect(loaders.parent).toHaveBeenCalledTimes(1)
    expect(loaders.child).toHaveBeenCalledTimes(1)
    expect(loaders.grandchild).toHaveBeenCalledTimes(1)
  })

  it('protects recursive lazy embedded language loading from cycles', async () => {
    const loaders: ShikiLanguageLoaderMap = {
      alpha: languageLoader(grammar('source.alpha', { embeddedLangsLazy: ['bravo'] })),
      bravo: languageLoader(grammar('source.bravo', { embeddedLangsLazy: ['alpha'] }))
    }
    const resolver = createShikiLanguageResolver(loaders)

    await expect(resolver.loadLanguage('alpha')).resolves.toMatchObject([
      { scopeName: 'source.bravo' },
      { scopeName: 'source.alpha' }
    ])
    expect(loaders.alpha).toHaveBeenCalledTimes(1)
    expect(loaders.bravo).toHaveBeenCalledTimes(1)
  })

  it('skips missing lazy embedded languages without throwing', async () => {
    const loaders: ShikiLanguageLoaderMap = {
      parent: languageLoader(grammar('source.parent', { embeddedLangsLazy: ['missing'] }))
    }
    const resolver = createShikiLanguageResolver(loaders)

    await expect(resolver.loadLanguage('parent')).resolves.toMatchObject([
      { scopeName: 'source.parent' }
    ])
  })

  it('caches loaded languages across repeated root and embedded requests', async () => {
    const loaders: ShikiLanguageLoaderMap = {
      parent: languageLoader(grammar('source.parent', { embeddedLangsLazy: ['child'] })),
      child: languageLoader(grammar('source.child'))
    }
    const resolver = createShikiLanguageResolver(loaders)

    await resolver.loadLanguage('parent')
    await resolver.loadLanguage('parent')
    await resolver.loadLanguage('child')

    expect(loaders.parent).toHaveBeenCalledTimes(1)
    expect(loaders.child).toHaveBeenCalledTimes(1)
  })
})
