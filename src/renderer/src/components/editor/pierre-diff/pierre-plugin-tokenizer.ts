import type {
  DiffsEditorTokenizer,
  DiffsEditorTokenizerOptions,
  DiffsHighlighter,
  HighlightedToken
} from '@pierre/diffs'
import type { TextDocumentChange } from '@pierre/diffs/edit'
import { PluginGrammarWorkerClient } from '@/lib/monaco-languages/plugin-grammar-worker-client'
import { PLUGIN_SYNTAX_TOKEN_TYPES } from '@/lib/monaco-languages/plugin-syntax-token-legend'
import { pluginMonacoTokenRules } from '@/lib/editor/appearance/plugin-monaco-token-rules'
import type { PluginSyntaxPayload } from '../../../../../shared/plugins/artifacts/plugin-syntax-artifact'
import type { PluginGrammarFailure } from '@/lib/monaco-languages/plugin-grammar-worker-client'
import {
  PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT,
  PLUGIN_GRAMMAR_MODEL_LINE_LIMIT,
  type PluginGrammarTokens
} from '@/lib/monaco-languages/plugin-grammar-protocol'

export class PierrePluginTokenizer implements DiffsEditorTokenizer {
  private client: Promise<PluginGrammarWorkerClient | null>
  private controller: AbortController | undefined
  private disposed = false
  private failed = false
  private paused = false
  private version = -1
  private theme: string
  private tokenRanges: Map<number, [number, number][]> | undefined
  private deferred: Map<number, HighlightedToken[]> | undefined

  constructor(
    private readonly options: DiffsEditorTokenizerOptions,
    private readonly highlighter: DiffsHighlighter,
    load: () => Promise<PluginSyntaxPayload | null>,
    createWorker: ConstructorParameters<typeof PluginGrammarWorkerClient>[2],
    private readonly onFailure: (reason: PluginGrammarFailure) => void
  ) {
    this.theme = options.theme
    this.client = load()
      .then((payload) =>
        payload && !this.disposed
          ? new PluginGrammarWorkerClient(payload.scopeName, payload.grammars, createWorker)
          : null
      )
      .catch(() => null)
  }

  tokenize(change: TextDocumentChange): Map<number, HighlightedToken[]> {
    this.tokenRanges = undefined
    this.request()
    const lines = new Map<number, HighlightedToken[]>()
    for (let line = change.startLine; line <= change.endLine; line += 1) {
      lines.set(line, [[0, '', this.options.textDocument.getLineText(line)]])
    }
    return lines
  }

  prebuildStateStack(): void {
    this.request()
  }

  setTheme(theme: string): void {
    this.theme = theme
    this.version = -1
    this.request()
  }

  stopBackgroundTokenize(): void {
    this.controller?.abort()
    this.controller = undefined
    this.version = -1
    this.deferred = undefined
  }

  pauseBackgroundTokenize(): void {
    this.paused = true
  }

  resumeBackgroundTokenize(): void {
    this.paused = false
    if (this.deferred) {
      this.options.onDeferTokenize(this.deferred)
      this.deferred = undefined
    }
    this.request()
  }

  dispose(): void {
    this.disposed = true
    this.stopBackgroundTokenize()
    void this.client.then((client) => client?.dispose())
  }

  getStringCommentRegexpRangesInLine(line: number): [number, number][] | null {
    return this.tokenRanges?.get(line) ?? (this.tokenRanges ? [] : null)
  }

  private request(): void {
    const document = this.options.textDocument
    if (this.disposed || this.failed || this.paused || document.version === this.version) {
      return
    }
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.version = document.version
    const version = document.version
    // Capture the snapshot before yielding; edits must never be painted with an older answer.
    if (document.lineCount > PLUGIN_GRAMMAR_MODEL_LINE_LIMIT) {
      return
    }
    const text = document.getText()
    if (text.length > PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT) {
      return
    }
    const lines = Array.from({ length: document.lineCount }, (_, line) =>
      document.getLineText(line)
    )
    void this.client.then(async (client) => {
      if (controller.signal.aborted) {
        return
      }
      const outcome = client
        ? await client.tokenize(
            text,
            lines.map((line) => line.length),
            controller.signal
          )
        : { ok: false as const, reason: 'unavailable' as const }
      if (controller.signal.aborted || this.disposed || document.version !== version) {
        return
      }
      if (outcome.ok) {
        const tokenRanges = new Map<number, [number, number][]>()
        const data = outcome.tokens.data
        for (let offset = 0; offset < data.length; offset += 4) {
          const line = data[offset],
            start = data[offset + 1],
            length = data[offset + 2],
            type = data[offset + 3]
          if (type <= 2 || PLUGIN_SYNTAX_TOKEN_TYPES[type]?.startsWith('string')) {
            const ranges = tokenRanges.get(line) ?? []
            ranges.push([start, start + length])
            tokenRanges.set(line, ranges)
          }
        }
        this.tokenRanges = tokenRanges
        const painted = this.paint(lines, outcome.tokens)
        if (this.paused) {
          this.deferred = painted
        } else {
          this.options.onDeferTokenize(painted)
        }
      } else if (outcome.reason !== 'aborted') {
        this.failed = outcome.reason !== 'size'
        if (this.failed) {
          this.onFailure(outcome.reason)
        }
        this.options.onDeferTokenize(new Map(lines.map((line, index) => [index, [[0, '', line]]])))
      }
    })
  }

  private paint(lines: string[], tokens: PluginGrammarTokens): Map<number, HighlightedToken[]> {
    const theme = this.highlighter.getTheme(this.theme)
    const rules = pluginMonacoTokenRules(theme.textmate?.tokenColors ?? [], (color) => color)
    const colors = PLUGIN_SYNTAX_TOKEN_TYPES.map(
      (type) => rules.findLast((rule) => rule.token === type)?.foreground ?? theme.fg
    )
    const result = new Map<number, HighlightedToken[]>()
    let offset = 0
    for (let line = 0; line < lines.length; line += 1) {
      const text = lines[line]
      const runs: HighlightedToken[] = []
      let end = 0
      while (offset < tokens.data.length && tokens.data[offset] === line) {
        const start = tokens.data[offset + 1]
        const nextEnd = start + tokens.data[offset + 2]
        if (start > end) {
          runs.push([end, theme.fg, text.slice(end, start)])
        }
        runs.push([start, colors[tokens.data[offset + 3]], text.slice(start, nextEnd)])
        end = nextEnd
        offset += 4
      }
      if (end < text.length || !runs.length) {
        runs.push([end, theme.fg, text.slice(end)])
      }
      result.set(line, runs)
    }
    return result
  }
}
