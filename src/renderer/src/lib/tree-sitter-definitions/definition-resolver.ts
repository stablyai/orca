import type { GlobalSettings } from '../../../../shared/types'
import { escapeRegex } from '../../../../shared/string-utils'
import { searchRuntimeFiles, readRuntimeFileContent } from '@/runtime/runtime-file-client'
import { grammarForPath, resolvesTogether } from './language-registry'
import { extractDefinitions } from './engine'
import type { GrammarName } from './definition-queries'

export type ResolverContext = {
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
}

export type DefinitionLocation = {
  filePath: string
  relativePath: string
  line: number
  column: number
}

export type CancellationToken = { isCancellationRequested: boolean }

type CandidateFile = { filePath: string; relativePath: string; defLikely?: boolean }

// Injectable seams so the orchestration is testable without ripgrep/WASM.
export type ResolverDeps = {
  search: (symbol: string, ctx: ResolverContext) => Promise<CandidateFile[]>
  read: (file: CandidateFile, ctx: ResolverContext) => Promise<string | null>
  extract: (
    grammarPath: string,
    content: string
  ) => Promise<{ name: string; line: number; column: number }[]>
}

// Cap how many grep hits we parse per lookup, parse a few at a time, and memo
// recent results so Monaco's hover + click on the same symbol reuse one search.
const MAX_CANDIDATE_FILES = 40
const READ_CONCURRENCY = 6
const CACHE_TTL_MS = 4000
const CACHE_MAX_ENTRIES = 64
// ripgrep caps TOTAL matches (not files); keep it generous so a symbol's
// defining file is still returned even when the symbol is referenced widely.
const SEARCH_MATCH_BUDGET = 1000
// Skip parsing very large files: tree-sitter parses synchronously on the
// renderer thread, so a multi-MB (often generated) file would jank the editor,
// and definitions rarely live in such files. Length is in UTF-16 code units —
// an approximate size proxy, which is all this guard needs.
const MAX_PARSE_CHARS = 512 * 1024

const resultCache = new Map<string, { at: number; locations: DefinitionLocation[] }>()

// Cheap signal from the grep match line that a file likely DEFINES the symbol
// (vs. merely referencing it), used to rank candidates so the real definition
// survives the file cap. Ranking only — never excludes, so false negatives are
// harmless.
const DEF_KEYWORDS =
  /\b(def|class|function|func|fn|type|interface|struct|enum|trait|impl|module|namespace|const|let|var|val|public|private|protected|static|export|declare|sub|proc)\b/
/** Heuristic over a grep match line: does it look like a DEFINITION of `symbol` (vs. a reference)? Used for ranking only — never excludes. */
export function looksLikeDefinition(symbol: string, line: string): boolean {
  if (!line.includes(symbol)) {
    return false
  }
  if (DEF_KEYWORDS.test(line)) {
    return true
  }
  // Top-level binding: `symbol = ...` / `symbol: T`. `=(?!=)` so a comparison
  // like `symbol == x` isn't mistaken for an assignment. Escape the symbol so
  // metacharacters in valid identifiers (e.g. `$` in `$scope`) match literally.
  return new RegExp(`(^|[^\\w.])${escapeRegex(symbol)}\\s*(?::|=(?!=))`).test(line)
}

const defaultDeps: ResolverDeps = {
  /** Grep the worktree for `symbol` (ripgrep via runtime RPC; works local + SSH), flagging files whose match line looks like a definition. */
  async search(symbol, ctx) {
    const result = await searchRuntimeFiles(
      {
        settings: ctx.settings,
        worktreeId: ctx.worktreeId,
        worktreePath: ctx.worktreePath,
        connectionId: ctx.connectionId
      },
      {
        query: symbol,
        rootPath: ctx.worktreePath,
        caseSensitive: true,
        wholeWord: true,
        useRegex: false,
        maxResults: SEARCH_MATCH_BUDGET
      }
    )
    return (result.files ?? []).map((f) => ({
      filePath: f.filePath,
      relativePath: f.relativePath,
      defLikely: f.matches?.some((m) => looksLikeDefinition(symbol, m.lineContent)) ?? false
    }))
  },
  /** Read a candidate file's text via the runtime, returning null for binary or unreadable files. */
  async read(file, ctx) {
    try {
      const content = await readRuntimeFileContent({
        settings: ctx.settings,
        filePath: file.filePath,
        relativePath: file.relativePath,
        worktreeId: ctx.worktreeId,
        connectionId: ctx.connectionId
      })
      return content.isBinary ? null : content.content
    } catch {
      return null
    }
  },
  /** Tree-sitter-extract the definition captures from file content for the given grammar. */
  extract: (grammarPath, content) => extractDefinitions(grammarPath as GrammarName, content)
}

/**
 * Find where `symbol` is DEFINED across the worktree: grep for the token
 * (ripgrep, works local + SSH), then tree-sitter-parse only the matching files
 * of the same language and keep the definition captures whose name matches.
 * Degrades to an empty result on search failure rather than rejecting.
 */
export async function resolveDefinitions(
  symbol: string,
  ctx: ResolverContext,
  opts: { fromGrammar?: GrammarName | null; deps?: ResolverDeps; token?: CancellationToken } = {}
): Promise<DefinitionLocation[]> {
  const deps = opts.deps ?? defaultDeps
  const fromGrammar = opts.fromGrammar ?? null
  const token = opts.token
  if (!symbol || !ctx.worktreePath) {
    return []
  }

  // Cache only the real (non-injected) path so unit tests stay isolated.
  const useCache = !opts.deps
  const cacheKey = JSON.stringify([ctx.worktreeId, fromGrammar ?? '', symbol])
  if (useCache) {
    const hit = resultCache.get(cacheKey)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return hit.locations
    }
  }

  // A failing search (e.g. a dropped/timed-out SSH RPC) degrades to no result
  // instead of rejecting the whole provider on every hover.
  let matches: CandidateFile[]
  try {
    matches = await deps.search(symbol, ctx)
  } catch {
    return []
  }
  if (token?.isCancellationRequested) {
    return []
  }

  // Filter to the requesting language BEFORE the cap so unrelated languages
  // don't consume the budget and never resolve a same-named symbol elsewhere.
  // Resolve the grammar once here and carry it forward.
  const candidates = matches
    .map((file) => ({ file, grammar: grammarForPath(file.relativePath || file.filePath) }))
    .filter(
      (c): c is { file: CandidateFile; grammar: GrammarName } =>
        c.grammar !== null && (!fromGrammar || resolvesTogether(c.grammar, fromGrammar))
    )
  // Parse likely-definition files first (stable sort) so the cap doesn't drop
  // the real definition when a symbol has many references.
  candidates.sort((a, b) => Number(b.file.defLikely ?? false) - Number(a.file.defLikely ?? false))
  const capped = candidates.slice(0, MAX_CANDIDATE_FILES)

  const out: DefinitionLocation[] = []
  for (let i = 0; i < capped.length; i += READ_CONCURRENCY) {
    if (token?.isCancellationRequested) {
      break
    }
    const batch = await Promise.all(
      capped.slice(i, i + READ_CONCURRENCY).map(async ({ file, grammar }) => {
        // One unreadable/unparseable file must not reject the whole batch and
        // abort an otherwise-resolvable lookup.
        try {
          const content = await deps.read(file, ctx)
          if (content === null || content.length > MAX_PARSE_CHARS) {
            return []
          }
          return (await deps.extract(grammar, content))
            .filter((def) => def.name === symbol)
            .map((def) => ({
              filePath: file.filePath,
              relativePath: file.relativePath,
              line: def.line,
              column: def.column
            }))
        } catch {
          return []
        }
      })
    )
    for (const locations of batch) {
      out.push(...locations)
    }
  }

  if (useCache && !token?.isCancellationRequested) {
    if (resultCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = resultCache.keys().next().value
      if (oldest !== undefined) {
        resultCache.delete(oldest)
      }
    }
    resultCache.set(cacheKey, { at: Date.now(), locations: out })
  }
  return out
}
