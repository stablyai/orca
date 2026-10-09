import type { Grammar, HighlighterCore, RegexEngine } from 'shiki/core'
import type * as ShikiTextmate from 'shiki/textmate'
import type { StateStack } from 'shiki/textmate'
import { BoundedMap } from '../../../../shared/bounded-map'
import { loadOniguruma, type Oniguruma } from './oniguruma'
import { withVueTemplateInjections } from './vue-template-injections'

export type SyntaxToken = {
  content: string
  /** Position in the highlighted text; unique within a line. */
  offset: number
  /** Undefined where the theme uses its default text color, so the surface's own color shows. */
  light: string | undefined
  dark: string | undefined
  /** `SYNTAX_FONT_STYLE` bits; each theme formats on its own. */
  lightFontStyle: number
  darkFontStyle: number
}

/** TextMate's font style bits. */
export const SYNTAX_FONT_STYLE = { italic: 1, bold: 2, underline: 4, strikethrough: 8 } as const

/**
 * `ok`: every line is colored. `degraded`: a line was too long or too slow, so
 * it and every later line of the document stay plain. `failed`: the grammar
 * threw, so the code stays plain.
 */
export type SyntaxHighlightOutcome = 'ok' | 'degraded' | 'failed'

/** Opaque: where a document's highlighting stopped, to continue it after its last line. */
export type SyntaxHighlightState = ResumeState

export type SyntaxHighlightResult = {
  lines: SyntaxToken[][]
  state: SyntaxHighlightState
  outcome: SyntaxHighlightOutcome
}

/**
 * Colors `code` (one or more lines) in VS Code's Light+ and Dark+ themes,
 * continuing from `state` when that is what the call for the text just before
 * `code` returned.
 */
export type SyntaxHighlighter = (
  code: string,
  state?: SyntaxHighlightState
) => SyntaxHighlightResult

/** `unsupported`: no grammar for the language. `failed`: the grammar could not load. */
export type SyntaxLanguageStatus = 'ready' | 'unsupported' | 'failed'

const THEMES = { light: 'light-plus', dark: 'dark-plus' } as const
// Why: one dense line cannot be interrupted, and its cost grows faster than its length.
const MAX_HIGHLIGHTED_LINE_LENGTH = 1000
// Why: TextMate checks this between regex scans, so a pathological line ends instead of freezing chat.
const LINE_TIME_LIMIT_MS = 50
const LINE_ATTEMPTS = 3
const MAX_LOAD_ATTEMPTS = 3
const LOAD_RETRY_DELAY_MS = 2000
// Arbitrary fence labels must not grow the table without limit.
const MAX_PENDING_LANGUAGES = 256

type ThemeStacks = { light: StateStack; dark: StateStack }

class ResumeState {
  /** `stacks` is null once the document degraded; it never resumes coloring after that. */
  constructor(
    readonly grammar: Grammar | null,
    readonly stacks: ThemeStacks | null
  ) {}
}

const DEGRADED = new ResumeState(null, null)

type Highlighter = { core: HighlighterCore; textmate: typeof ShikiTextmate }

type PendingLanguage =
  | { status: 'loading'; promise: Promise<SyntaxLanguageStatus>; attempts: number }
  | { status: 'unsupported' }
  | { status: 'failed'; attempts: number; retryAt: number }

// Only catalogue names reach this map, so it is bounded by the catalogue.
const readyLanguages = new Map<string, SyntaxHighlighter>()
const pendingLanguages = new BoundedMap<string, PendingLanguage>({
  maxEntries: MAX_PENDING_LANGUAGES
})
let highlighterPromise: Promise<Highlighter> | undefined
let loadFailureLogged = false

function onigurumaEngine(oniguruma: Oniguruma): RegexEngine {
  return {
    createScanner: (patterns) => {
      const scanner = oniguruma.createOnigScanner(
        patterns.map((pattern) => (typeof pattern === 'string' ? pattern : pattern.source))
      )
      return {
        // Why: Shiki's TextMate always passes no find options, so none are forwarded.
        findNextMatchSync: (text, startPosition) =>
          scanner.findNextMatchSync(
            typeof text === 'string' || text instanceof oniguruma.OnigString ? text : text.content,
            startPosition
          ),
        dispose: () => scanner.dispose()
      }
    },
    createString: (text) => oniguruma.createOnigString(text)
  }
}

function loadHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, textmate, oniguruma, light, dark] = await Promise.all([
      import('shiki/core'),
      import('shiki/textmate'),
      loadOniguruma(),
      import('shiki/themes/light-plus.mjs'),
      import('shiki/themes/dark-plus.mjs')
    ])
    const core = await createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      // Why: Orca already ships this regex engine for the editor; a second WASM copy would add ~150 KB.
      engine: onigurumaEngine(oniguruma)
    })
    return { core, textmate }
  })().catch((error: unknown) => {
    highlighterPromise = undefined
    throw error
  })
  return highlighterPromise
}

function plainLine(line: string, offset: number): SyntaxToken[] {
  return line
    ? [
        {
          content: line,
          offset,
          light: undefined,
          dark: undefined,
          lightFontStyle: 0,
          darkFontStyle: 0
        }
      ]
    : []
}

/** Lines split like Shiki splits them, each with its offset in `code`. */
function splitLines(code: string): { line: string; offset: number }[] {
  let offset = 0
  return code.split(/\r?\n/).map((line) => {
    const start = offset
    offset = code.indexOf('\n', start + line.length) + 1
    return { line, offset: start }
  })
}

function plainResult(code: string, outcome: SyntaxHighlightOutcome): SyntaxHighlightResult {
  return {
    lines: splitLines(code).map(({ line, offset }) => plainLine(line, offset)),
    state: DEGRADED,
    outcome
  }
}

type ThemeTokens = { starts: number[]; colors: (string | undefined)[]; styles: number[] }

/** Tokenizes in one theme up to the first line that is too long or too slow. */
function tokenizeWithTheme(
  { core, textmate }: Highlighter,
  grammar: Grammar,
  theme: string,
  lines: string[],
  initial: StateStack
): { tokens: ThemeTokens[]; stack: StateStack } {
  const { colorMap, theme: resolved } = core.setTheme(theme)
  const defaultColor = resolved.fg.toUpperCase()
  const { getForeground, getFontStyle } = textmate.EncodedTokenMetadata
  const tokens: ThemeTokens[] = []
  let stack = initial
  for (const line of lines) {
    if (line.length > MAX_HIGHLIGHTED_LINE_LENGTH) {
      break
    }
    let result = grammar.tokenizeLine2(line, stack, LINE_TIME_LIMIT_MS)
    // Why: the first lines through a grammar also compile its regexes, which happens only once.
    for (let attempt = 1; result.stoppedEarly && attempt < LINE_ATTEMPTS; attempt += 1) {
      result = grammar.tokenizeLine2(line, stack, LINE_TIME_LIMIT_MS)
    }
    if (result.stoppedEarly) {
      break
    }
    const lineTokens: ThemeTokens = { starts: [], colors: [], styles: [] }
    for (let index = 0; index < result.tokens.length; index += 2) {
      const metadata = result.tokens[index + 1]
      const color = colorMap[getForeground(metadata)]
      lineTokens.starts.push(result.tokens[index])
      lineTokens.colors.push(color?.toUpperCase() === defaultColor ? undefined : color)
      lineTokens.styles.push(Math.max(0, getFontStyle(metadata)))
    }
    tokens.push(lineTokens)
    stack = result.ruleStack
  }
  return { tokens, stack }
}

/** Splits the line wherever either theme starts a token, so each piece carries both themes. */
function mergeThemeTokens(
  line: string,
  offset: number,
  light: ThemeTokens,
  dark: ThemeTokens
): SyntaxToken[] {
  const tokens: SyntaxToken[] = []
  let lightIndex = 0
  let darkIndex = 0
  let start = 0
  while (start < line.length) {
    while (lightIndex + 1 < light.starts.length && light.starts[lightIndex + 1] <= start) {
      lightIndex += 1
    }
    while (darkIndex + 1 < dark.starts.length && dark.starts[darkIndex + 1] <= start) {
      darkIndex += 1
    }
    const end = Math.min(
      light.starts[lightIndex + 1] ?? line.length,
      dark.starts[darkIndex + 1] ?? line.length,
      line.length
    )
    tokens.push({
      content: line.slice(start, end),
      offset: offset + start,
      light: light.colors[lightIndex],
      dark: dark.colors[darkIndex],
      lightFontStyle: light.styles[lightIndex] ?? 0,
      darkFontStyle: dark.styles[darkIndex] ?? 0
    })
    start = end
  }
  return tokens
}

function createSyntaxHighlighter(highlighter: Highlighter, grammarName: string): SyntaxHighlighter {
  return (code, state) => {
    if (state && !state.stacks) {
      return plainResult(code, 'degraded')
    }
    try {
      const grammar = highlighter.core.getLanguage(grammarName)
      // Why: loading a language another grammar embeds reloads that grammar, which cannot read old states.
      if (state && state.grammar !== grammar) {
        return plainResult(code, 'degraded')
      }
      const lines = splitLines(code)
      const text = lines.map(({ line }) => line)
      const { INITIAL } = highlighter.textmate
      const light = tokenizeWithTheme(
        highlighter,
        grammar,
        THEMES.light,
        text,
        state?.stacks?.light ?? INITIAL
      )
      // A line Light+ gave up on stays plain, so Dark+ need not try it.
      const dark = tokenizeWithTheme(
        highlighter,
        grammar,
        THEMES.dark,
        text.slice(0, light.tokens.length),
        state?.stacks?.dark ?? INITIAL
      )
      const complete = Math.min(light.tokens.length, dark.tokens.length)
      const tokens = lines.map(({ line, offset }, index) =>
        index < complete
          ? mergeThemeTokens(line, offset, light.tokens[index], dark.tokens[index])
          : plainLine(line, offset)
      )
      return complete < lines.length
        ? { lines: tokens, state: DEGRADED, outcome: 'degraded' }
        : {
            lines: tokens,
            state: new ResumeState(grammar, { light: light.stack, dark: dark.stack }),
            outcome: 'ok'
          }
    } catch {
      return plainResult(code, 'failed')
    }
  }
}

async function loadLanguage(key: string, attempts: number): Promise<SyntaxLanguageStatus> {
  try {
    const { bundledLanguagesInfo } = await import('shiki/langs')
    const info = bundledLanguagesInfo.find(
      (language) => language.id === key || language.aliases?.includes(key)
    )
    if (!info) {
      pendingLanguages.set(key, { status: 'unsupported' })
      return 'unsupported'
    }
    const [highlighter, { default: grammars }] = await Promise.all([
      loadHighlighter(),
      info.import()
    ])
    await highlighter.core.loadLanguage(...withVueTemplateInjections(grammars))
    readyLanguages.set(key, createSyntaxHighlighter(highlighter, info.id))
    pendingLanguages.delete(key)
    return 'ready'
  } catch (error) {
    pendingLanguages.set(key, {
      status: 'failed',
      attempts: attempts + 1,
      retryAt: performance.now() + LOAD_RETRY_DELAY_MS
    })
    if (!loadFailureLogged) {
      loadFailureLogged = true
      console.warn('[syntax-highlight] failed to load a grammar; code stays plain', error)
    }
    return 'failed'
  }
}

function languageKey(language: string): string {
  return language.trim().toLowerCase()
}

/**
 * Loads `language`'s grammar for `loadedSyntaxHighlighter`. A failed load is
 * retried by a later call, a few times at most.
 */
export function loadSyntaxLanguage(language: string): Promise<SyntaxLanguageStatus> {
  const key = languageKey(language)
  if (readyLanguages.has(key)) {
    return Promise.resolve('ready')
  }
  const pending = pendingLanguages.get(key)
  if (pending?.status === 'loading') {
    return pending.promise
  }
  if (pending?.status === 'unsupported') {
    return Promise.resolve('unsupported')
  }
  const attempts = pending?.attempts ?? 0
  if (
    pending?.status === 'failed' &&
    (attempts >= MAX_LOAD_ATTEMPTS || performance.now() < pending.retryAt)
  ) {
    return Promise.resolve('failed')
  }
  const promise = loadLanguage(key, attempts)
  pendingLanguages.set(key, { status: 'loading', promise, attempts })
  return promise
}

/** The highlighter for a language that has loaded, so a block can color in the same render. */
export function loadedSyntaxHighlighter(language: string): SyntaxHighlighter | null {
  return readyLanguages.get(languageKey(language)) ?? null
}
