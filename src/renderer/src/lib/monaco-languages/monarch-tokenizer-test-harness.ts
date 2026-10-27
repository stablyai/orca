import type * as Monaco from 'monaco-editor'
import { compile } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js'
import { MonarchTokenizer } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchLexer.js'
import { MAX_TOKENIZATION_LINE_LENGTH } from './monarch-embed-entry-budget'

// Drives the real `MonarchTokenizer` shipped with monaco-editor rather than
// walking a grammar's rule table. A table walk cannot see the failures that
// actually reach the renderer — a grammar that throws on every `{expr}`, or
// that silently drops an embed, still has a well-formed rule table.

/** One Monaco token. `language` is the (embedded) language the region belongs to. */
export type MonarchToken = { offset: number; type: string; language: string }

type MonarchEndState = { embeddedLanguageData?: { languageId: string } | null }

export type MonarchTokenizerInstance = {
  getInitialState: () => unknown
  tokenize: (
    line: string,
    hasEOL: boolean,
    state: unknown
  ) => { tokens: MonarchToken[]; endState: MonarchEndState }
  _nestedTokenize: (...args: unknown[]) => unknown
}

export function createMonarchTokenizer(
  languageId: string,
  language: Monaco.languages.IMonarchLanguage,
  maxTokenizationLineLength = MAX_TOKENIZATION_LINE_LENGTH
): MonarchTokenizerInstance {
  // Nested languages stay unregistered, so `nestedLanguageTokenize` emits one
  // empty-typed token tagged with the embedded language id instead of running
  // that language's tokenizer. That is what makes `token.language` a direct
  // readout of which embed covers which region.
  const languageService = {
    languageIdCodec: { encodeLanguageId: () => 1, decodeLanguageId: () => '' },
    getLanguageIdByLanguageName: () => null,
    getLanguageIdByMimeType: () => null,
    isRegisteredLanguageId: () => false,
    requestBasicLanguageFeatures: () => {}
  }
  const themeService = { getColorTheme: () => ({ tokenTheme: {} }) }
  const configurationService = {
    getValue: () => maxTokenizationLineLength,
    onDidChangeConfiguration: () => ({ dispose: () => {} })
  }

  return new MonarchTokenizer(
    languageService,
    themeService,
    languageId,
    compile(languageId, language),
    configurationService
  ) as MonarchTokenizerInstance
}

export type TokenizedLine = {
  text: string
  tokens: MonarchToken[]
  /** Embedded language still active at end of line; `null` means that region renders unhighlighted. */
  endEmbeddedLanguageId: string | null
}

/** Tokenizes `lines` as one document, threading tokenizer state line to line. */
export function tokenizeLines(
  tokenizer: MonarchTokenizerInstance,
  lines: string[]
): TokenizedLine[] {
  let state: unknown = tokenizer.getInitialState()
  return lines.map((text) => {
    const { tokens, endState } = tokenizer.tokenize(text, true, state)
    state = endState
    return {
      text,
      tokens,
      endEmbeddedLanguageId: endState.embeddedLanguageData?.languageId ?? null
    }
  })
}

export function tokenizeMonarchDocument(
  languageId: string,
  language: Monaco.languages.IMonarchLanguage,
  source: string
): TokenizedLine[] {
  return tokenizeLines(createMonarchTokenizer(languageId, language), source.split('\n'))
}

/** The embedded language each line *ends* in — `null` for no embed. */
export function endEmbeddedLanguages(lines: TokenizedLine[]): (string | null)[] {
  return lines.map((line) => line.endEmbeddedLanguageId)
}

/** The distinct languages a line's tokens were attributed to, in order. */
export function tokenLanguages(line: TokenizedLine): string[] {
  return line.tokens
    .map((token) => token.language)
    .filter((language, index, all) => language !== all[index - 1])
}

/**
 * Per line, which languages actually cover it. This is the readout that catches
 * a silently dropped embed: the region falls back to the host grammar's own id
 * instead of `html` / `typescript` / `scss`, and renders unhighlighted.
 */
export function tokenLanguagesPerLine(lines: TokenizedLine[]): string[][] {
  return lines.map(tokenLanguages)
}

/** Token type covering `index`, without the grammar's `tokenPostfix`. */
export function tokenTypeAt(line: TokenizedLine, index: number): string {
  const covering = line.tokens.findLast((token) => token.offset <= index)
  return covering?.type.split('.').slice(0, -1).join('.') ?? ''
}

/** One `text | offset:type@language … | embed=…` row per line, for snapshots. */
export function formatTokenizedLines(lines: TokenizedLine[]): string[] {
  return lines.map((line) => {
    const tokens = line.tokens
      .map((token) => `${token.offset}:${token.type || '-'}@${token.language}`)
      .join(' ')
    return `${line.text} | ${tokens} | embed=${line.endEmbeddedLanguageId ?? 'none'}`
  })
}

export type TokenizeMeasurement = { maxNestedDepth: number; error: Error | undefined }

/**
 * Tokenizes `lines`, recording peak `_nestedTokenize` recursion — the real JS
 * stack cost, since Monarch enters an embed by mutual recursion with no TCO.
 * Embeds cannot nest, so this counts sequential embed enter/exit transitions on
 * one line, each holding a frame until the line ends. Errors are captured rather
 * than thrown so a caller can assert on frame count and failure together.
 */
export function measureNestedDepth(
  tokenizer: MonarchTokenizerInstance,
  lines: string[]
): TokenizeMeasurement {
  const nestedTokenize = tokenizer._nestedTokenize.bind(tokenizer)
  let depth = 0
  let maxNestedDepth = 0
  tokenizer._nestedTokenize = (...args: unknown[]) => {
    depth += 1
    maxNestedDepth = Math.max(maxNestedDepth, depth)
    try {
      return nestedTokenize(...args)
    } finally {
      depth -= 1
    }
  }

  let error: Error | undefined
  try {
    tokenizeLines(tokenizer, lines)
  } catch (thrown) {
    error = thrown as Error
  }
  return { maxNestedDepth, error }
}
