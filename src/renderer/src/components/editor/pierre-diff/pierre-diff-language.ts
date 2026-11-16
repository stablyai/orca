import { useMemo } from 'react'
import { getFiletypeFromFileName, registerCustomLanguage } from '@pierre/diffs'
import { bundledLanguagesInfo, type LanguageRegistration } from 'shiki'
import {
  parsePluginSyntaxPayload,
  type PluginSyntaxMetadata
} from '../../../../../shared/plugins/artifacts/plugin-syntax-artifact'
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
  return SHIKI_IDS.get(language) ?? 'text'
}

const pluginLanguages = new Map<string, string>()

function registerPluginSyntax(syntax: PluginSyntaxMetadata): string {
  const key = pluginSyntaxRevisionKey(syntax)
  const registered = pluginLanguages.get(key)
  if (registered) {
    return registered
  }
  // Each revision gets its own name so an updated grammar is not served from Shiki's cache.
  const name = `orca-plugin-syntax-${pluginLanguages.size}`
  pluginLanguages.set(key, name)
  registerCustomLanguage(name, async () => {
    const payload = parsePluginSyntaxPayload(
      await window.api.plugins.loadSyntax(syntax.id).catch(() => null)
    )
    const grammars: LanguageRegistration[] = payload
      ? payload.grammars.map((grammar, index) => ({
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main validated each grammar's shape; TextMate reads applyEndPatternLast 0/1 like a boolean.
          ...(grammar as Omit<LanguageRegistration, 'name'>),
          name: grammar.scopeName === payload.scopeName ? name : `${name}-${index}`,
          workerOnly: true
        }))
      : [{ name, scopeName: `text.${name}`, patterns: [], repository: {} }]
    return { default: grammars }
  })
  return name
}

/** Plugin grammars are worker-only; the renderer's registered fallback has no patterns. */
export function usePierreDiffLanguage(filePath: string, coreLanguage: string): string {
  const syntaxes = usePluginSyntaxes()
  const syntax = resolvePluginSyntaxForFile(syntaxes, filePath, coreLanguage)
  return useMemo(
    () =>
      syntax ? registerPluginSyntax(syntax) : resolvePierreDiffLanguage(filePath, coreLanguage),
    [syntax, filePath, coreLanguage]
  )
}
