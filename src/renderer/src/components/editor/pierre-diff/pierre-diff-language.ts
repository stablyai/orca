import { useLayoutEffect, useMemo, useState } from 'react'
import {
  getFiletypeFromFileName,
  registerCustomLanguage,
  unregisterCustomLanguage
} from '@pierre/diffs'
import { bundledLanguagesInfo, type LanguageRegistration } from 'shiki'
import {
  parsePluginSyntaxPayload,
  type PluginSyntaxMetadata
} from '../../../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { retirePierreHighlightLanguage } from './pierre-diff-highlight-pool'
import { PLUGIN_SYNTAX_SLOT_LIMIT } from '@/lib/monaco-languages/plugin-syntax-slot-pool'
import { pluginSyntaxRevisionKey } from '@/store/plugins/syntax/plugin-syntax-failures'
import {
  resolvePluginSyntaxForFile,
  usePluginSyntaxes
} from '@/store/plugins/syntax/plugin-syntax-packs'

// Monaco ids Shiki names differently, or lacks; the right side is the closest Shiki grammar.
const MONACO_TO_SHIKI: Record<string, string> = {
  plaintext: 'text',
  notebook: 'json',
  sol: 'solidity',
  systemverilog: 'system-verilog',
  restructuredtext: 'rst',
  quarto: 'markdown',
  'cuda-cpp': 'cpp',
  mysql: 'sql',
  pgsql: 'sql',
  redshift: 'sql',
  azcli: 'shellscript',
  pascaligo: 'pascal',
  cameligo: 'ocaml',
  freemarker2: 'html'
}

// Monaco ids that stand in for a richer Shiki dialect Monaco lacks (TSX, TOML, ...).
const SHIKI_DIALECTS: Record<string, readonly string[]> = {
  typescript: ['tsx'],
  javascript: ['jsx'],
  json: ['jsonc', 'json5'],
  markdown: ['mdx'],
  ini: ['toml'],
  graphql: ['prisma']
}

const SHIKI_IDS = new Map(
  bundledLanguagesInfo.flatMap((info) =>
    [info.id, ...(info.aliases ?? [])].map((name) => [name, info.id])
  )
)

/** The Shiki grammar for a file whose Monaco language came from `detectLanguage`. */
export function resolvePierreDiffLanguage(filePath: string, monacoLanguage: string): string {
  const basename = filePath.split(/[\\/]/).at(-1)!.toLowerCase()
  const dialect = getFiletypeFromFileName(basename)
  if (SHIKI_DIALECTS[monacoLanguage]?.includes(dialect)) {
    return dialect
  }
  const language =
    MONACO_TO_SHIKI[monacoLanguage] ??
    (monacoLanguage.startsWith('freemarker2.') ? 'html' : monacoLanguage)
  // Why: an id Shiki cannot load fails the whole highlight instead of painting plain text.
  if (language === 'redis' || language === 'qsharp') {
    registerLegacySyntax(language)
    return language
  }
  return SHIKI_IDS.get(language) ?? 'text'
}

const legacyLanguages = new Set<string>()
function registerLegacySyntax(name: 'redis' | 'qsharp'): void {
  if (legacyLanguages.has(name)) {
    return
  }
  legacyLanguages.add(name)
  registerCustomLanguage(name, async () => {
    const { buildLegacyDiffGrammar } = await import('./pierre-diff-legacy-grammar')
    return { default: [await buildLegacyDiffGrammar(name)] }
  })
}

const pluginLanguages = new Map<string, { name: string; refs: number }>()
let nextPluginLanguage = 0

function acquirePluginSyntax(
  syntax: PluginSyntaxMetadata
): { name: string; release: () => void } | null {
  const key = pluginSyntaxRevisionKey(syntax)
  const registered = pluginLanguages.get(key)
  if (registered) {
    registered.refs++
    return { name: registered.name, release: () => releasePluginSyntax(key, registered) }
  }
  if (pluginLanguages.size >= PLUGIN_SYNTAX_SLOT_LIMIT) {
    return null
  }
  // Each revision gets its own name so an updated grammar is not served from Shiki's cache.
  const name = `orca-plugin-syntax-${nextPluginLanguage++}`
  const registration = { name, refs: 1 }
  pluginLanguages.set(key, registration)
  registerCustomLanguage(name, async () => {
    const payload = parsePluginSyntaxPayload(await window.api.plugins.loadSyntax(syntax.id))
    if (!payload) {
      throw new Error('Plugin syntax is unavailable. Retry this file.')
    }
    const grammars: LanguageRegistration[] = payload.grammars.map((grammar, index) => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main validated each grammar's shape; TextMate reads applyEndPatternLast 0/1 like a boolean.
      ...(grammar as Omit<LanguageRegistration, 'name'>),
      name: grammar.scopeName === payload.scopeName ? name : `${name}-${index}`,
      workerOnly: true
    }))
    return { default: grammars }
  })
  return { name, release: () => releasePluginSyntax(key, registration) }
}

function releasePluginSyntax(key: string, registration: { name: string; refs: number }): void {
  if (--registration.refs > 0) {
    return
  }
  pluginLanguages.delete(key)
  unregisterCustomLanguage(registration.name)
  retirePierreHighlightLanguage(registration.name)
}

/** Plugin grammars are worker-only; the renderer's registered fallback has no patterns. */
export function usePierreDiffLanguage(filePath: string, coreLanguage: string): string {
  const syntaxes = usePluginSyntaxes()
  const syntax = resolvePluginSyntaxForFile(syntaxes, filePath, coreLanguage)
  const [lease, setLease] = useState<{ syntax: PluginSyntaxMetadata; name: string } | null>(null)
  useLayoutEffect(() => {
    if (!syntax) {
      return
    }
    const registration = acquirePluginSyntax(syntax)
    if (!registration) {
      return
    }
    setLease({ syntax, name: registration.name })
    return registration.release
  }, [syntax])
  const core = useMemo(
    () => resolvePierreDiffLanguage(filePath, coreLanguage),
    [filePath, coreLanguage]
  )
  return syntax ? (lease?.syntax === syntax ? lease.name : 'text') : core
}
