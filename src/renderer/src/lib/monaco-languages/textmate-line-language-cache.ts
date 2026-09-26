import type * as Monaco from 'monaco-editor'

const LANGUAGE_ID_MASK = 0xff
const DEFAULT_MAX_CONTEXT_LINE_LENGTH = 2_048
const DEFAULT_TOKENIZATION_TIME_SLICE_MS = 2

type TextMateLineLanguageCacheOptions = {
  maxTokenizationLineLength?: number
  now?: () => number
  tokenizationTimeSliceMs?: number
  yieldToEventLoop?: () => Promise<void>
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export class TextMateLineLanguageCache implements Monaco.IDisposable {
  private readonly lineStartLanguages: number[] = []
  private readonly lineStartStates: Monaco.languages.IState[]
  private readonly contentSubscription: Monaco.IDisposable
  private readonly maxTokenizationLineLength: number
  private readonly now: () => number
  private readonly tokenizationTimeSliceMs: number
  private readonly yieldToEventLoop: () => Promise<void>
  private tokenizationTail: Promise<void> = Promise.resolve()
  private unknownFromLine: number | null = null
  private disposed = false

  constructor(
    private readonly model: Monaco.editor.ITextModel,
    private readonly provider: Monaco.languages.EncodedTokensProvider,
    options: TextMateLineLanguageCacheOptions = {}
  ) {
    this.lineStartStates = [provider.getInitialState()]
    this.maxTokenizationLineLength = Math.max(
      1,
      options.maxTokenizationLineLength ?? DEFAULT_MAX_CONTEXT_LINE_LENGTH
    )
    this.now = options.now ?? (() => performance.now())
    this.tokenizationTimeSliceMs = Math.max(
      1,
      options.tokenizationTimeSliceMs ?? DEFAULT_TOKENIZATION_TIME_SLICE_MS
    )
    this.yieldToEventLoop = options.yieldToEventLoop ?? yieldToEventLoop
    this.contentSubscription = model.onDidChangeContent((event) => {
      const firstChangedLine = event.changes.reduce(
        (firstLine, change) => Math.min(firstLine, change.range.startLineNumber),
        Number.POSITIVE_INFINITY
      )
      if (Number.isFinite(firstChangedLine)) {
        this.invalidateFromLine(firstChangedLine)
      }
    })
  }

  getLanguagesAtLineStarts(lineNumbers: readonly number[]): Promise<(number | null)[]> {
    const run = this.tokenizationTail.then(
      () => this.readLanguagesAtLineStarts(lineNumbers),
      () => this.readLanguagesAtLineStarts(lineNumbers)
    )
    this.tokenizationTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  dispose(): void {
    this.disposed = true
    this.contentSubscription.dispose()
    this.lineStartLanguages.length = 0
    this.lineStartStates.length = 0
  }

  private async readLanguagesAtLineStarts(
    lineNumbers: readonly number[]
  ): Promise<(number | null)[]> {
    const requestedTargetLine = lineNumbers.reduce(
      (highestLine, lineNumber) => Math.max(highestLine, lineNumber),
      0
    )
    let timeSliceStartedAt = this.now()
    while (!this.disposed && !this.model.isDisposed()) {
      const targetLine = Math.min(requestedTargetLine, this.model.getLineCount())
      if (this.lineStartLanguages.length >= targetLine) {
        break
      }
      const nextLineNumber = this.lineStartLanguages.length + 1
      const line = this.model.getLineContent(nextLineNumber)
      if (line.length >= this.maxTokenizationLineLength) {
        this.unknownFromLine = nextLineNumber
        break
      }
      const startState = this.lineStartStates[nextLineNumber - 1]
      const result = this.provider.tokenizeEncoded(line, startState)
      this.lineStartLanguages.push(
        result.tokens.length >= 2 ? result.tokens[1] & LANGUAGE_ID_MASK : 0
      )
      this.lineStartStates.push(result.endState)
      if (
        nextLineNumber < targetLine &&
        this.now() - timeSliceStartedAt >= this.tokenizationTimeSliceMs
      ) {
        await this.yieldToEventLoop()
        timeSliceStartedAt = this.now()
      }
    }

    return lineNumbers.map((lineNumber) => {
      if (
        this.disposed ||
        this.model.isDisposed() ||
        (this.unknownFromLine !== null && lineNumber >= this.unknownFromLine) ||
        lineNumber < 1 ||
        lineNumber > this.lineStartLanguages.length
      ) {
        return null
      }
      return this.lineStartLanguages[lineNumber - 1] || null
    })
  }

  private invalidateFromLine(lineNumber: number): void {
    this.lineStartLanguages.length = Math.min(this.lineStartLanguages.length, lineNumber - 1)
    this.lineStartStates.length = Math.min(this.lineStartStates.length, lineNumber)
    if (this.unknownFromLine !== null && lineNumber <= this.unknownFromLine) {
      this.unknownFromLine = null
    }
  }
}
