// Lazy web-tree-sitter engine: initializes the runtime once and loads each
// grammar + its definitions query on first use. WASM assets are resolved
// through Vite's ?url so they are served/bundled like other static assets.
import { Parser, Language, Query } from 'web-tree-sitter'
import treeSitterWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url'
import tsUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm?url'
import tsxUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm?url'
import jsUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm?url'
import pyUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm?url'
import goUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm?url'
import rustUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm?url'
import javaUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm?url'
import csharpUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm?url'
import cppUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm?url'
import rubyUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-ruby.wasm?url'
import phpUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-php.wasm?url'
import bashUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm?url'
import { DEFINITION_QUERIES, type GrammarName } from './definition-queries'

const GRAMMAR_URL: Record<GrammarName, string> = {
  typescript: tsUrl,
  tsx: tsxUrl,
  javascript: jsUrl,
  python: pyUrl,
  go: goUrl,
  rust: rustUrl,
  java: javaUrl,
  'c-sharp': csharpUrl,
  cpp: cppUrl,
  ruby: rubyUrl,
  php: phpUrl,
  bash: bashUrl
}

type LoadedGrammar = { language: Language; query: Query }

let initPromise: Promise<void> | null = null
/** Initialize the web-tree-sitter runtime exactly once (memoized across calls). */
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({ locateFile: () => treeSitterWasmUrl })
  }
  return initPromise
}

const grammarCache = new Map<GrammarName, Promise<LoadedGrammar>>()
/** Load and cache a grammar plus its definitions query; a failed load is evicted so the next lookup can retry. */
function loadGrammar(grammar: GrammarName): Promise<LoadedGrammar> {
  let entry = grammarCache.get(grammar)
  if (!entry) {
    entry = (async () => {
      await ensureInit()
      const language = await Language.load(GRAMMAR_URL[grammar])
      return { language, query: new Query(language, DEFINITION_QUERIES[grammar]) }
    })()
    // Don't let a failed load (WASM fetch error, bad query) poison the grammar
    // forever — drop it so the next lookup can retry.
    entry.catch(() => grammarCache.delete(grammar))
    grammarCache.set(grammar, entry)
  }
  return entry
}

let sharedParser: Parser | null = null

/**
 * Extract { name, line, column } for every definition captured by the grammar's
 * query. line/column are 1-based to match Monaco.
 */
export async function extractDefinitions(
  grammar: GrammarName,
  code: string
): Promise<{ name: string; line: number; column: number }[]> {
  const { language, query } = await loadGrammar(grammar)
  if (!sharedParser) {
    sharedParser = new Parser()
  }
  sharedParser.setLanguage(language)
  const tree = sharedParser.parse(code)
  if (!tree) {
    return []
  }
  try {
    return query
      .captures(tree.rootNode)
      .filter((c) => c.name === 'name')
      .map((c) => ({
        name: c.node.text,
        line: c.node.startPosition.row + 1,
        column: c.node.startPosition.column + 1
      }))
  } finally {
    tree.delete?.()
  }
}
