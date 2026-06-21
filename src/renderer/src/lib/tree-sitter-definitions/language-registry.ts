import type { GrammarName } from './definition-queries'

// TypeScript, TSX and JavaScript share Monaco's language service and import
// across each other's files, so they resolve together as one family.
const MONACO_NATIVE_GRAMMARS = new Set<GrammarName>(['typescript', 'tsx', 'javascript'])

/**
 * Whether a candidate file's grammar can hold the definition for a symbol used
 * in a `from`-grammar file: same grammar, or both in the TS/JS family.
 */
export function resolvesTogether(candidate: GrammarName, from: GrammarName): boolean {
  return (
    candidate === from ||
    (MONACO_NATIVE_GRAMMARS.has(candidate) && MONACO_NATIVE_GRAMMARS.has(from))
  )
}

// File extension -> tree-sitter grammar used to parse it. The grammar is chosen
// by extension (e.g. .tsx needs the TSX grammar even though Monaco's id is
// 'typescript'); the provider is registered by Monaco language id below.
const EXT_TO_GRAMMAR: Record<string, GrammarName> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'c-sharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.c': 'cpp',
  '.h': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash'
}

// Monaco language ids to register the definition provider for. Includes
// typescript/javascript: Monaco's bundled TS service resolves same-file and
// already-loaded definitions but can't navigate cross-file to files it hasn't
// loaded, so we complement it there. The provider defers same-file results to
// Monaco (see definition-provider.ts) to avoid duplicates. Ids match
// EXT_TO_LANGUAGE in language-detect.ts.
export const PROVIDER_LANGUAGE_IDS = [
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'csharp',
  'cpp',
  'c',
  'ruby',
  'php',
  'shell'
] as const

/** Map a file path to its tree-sitter grammar by extension, or null when unsupported. */
export function grammarForPath(path: string): GrammarName | null {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) {
    return null
  }
  return EXT_TO_GRAMMAR[lower.slice(dot)] ?? null
}
