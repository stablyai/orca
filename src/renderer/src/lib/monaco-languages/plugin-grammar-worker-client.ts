import type { PluginGrammarArtifact } from '../../../../shared/plugins/plugin-syntax-artifact'
import {
  PLUGIN_GRAMMAR_DOCUMENT_DEADLINE_MS,
  PLUGIN_GRAMMAR_INIT_DEADLINE_MS,
  PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT,
  PLUGIN_GRAMMAR_MODEL_LINE_LIMIT,
  PLUGIN_GRAMMAR_PROGRESS_DEADLINE_MS,
  isValidPluginGrammarTokens,
  type PluginGrammarResponse,
  type PluginGrammarTokens,
  type PluginGrammarWorkerMessage
} from './plugin-grammar-protocol'
import { PLUGIN_SYNTAX_TOKEN_TYPES } from './plugin-syntax-token-legend'

export type PluginGrammarWorker = {
  postMessage: (message: PluginGrammarWorkerMessage) => void
  terminate: () => void
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

/** Why a grammar stopped highlighting. `stalled` and `crashed` end the engine for good. */
export type PluginGrammarFailure = 'size' | 'stalled' | 'crashed' | 'unavailable'

export type PluginGrammarOutcome =
  | { ok: true; tokens: PluginGrammarTokens }
  | { ok: false; reason: PluginGrammarFailure | 'aborted' }

// Why a grace period: typing pauses briefly; an idle grammar should not hold memory for long.
const IDLE_WORKER_MS = 60_000

type Job = {
  id: number
  text: string
  lineLengths: readonly number[]
  settle: (outcome: PluginGrammarOutcome) => void
  /** The caller moved on; the worker's answer for this job is dropped. */
  abandoned: boolean
  progressTimer?: ReturnType<typeof setTimeout>
  documentTimer?: ReturnType<typeof setTimeout>
}

function isResponse(value: unknown): value is PluginGrammarResponse {
  return typeof value === 'object' && value !== null && 'type' in value
}

/**
 * Runs one language's grammar in a worker that compiles it once and stays warm between
 * documents. Jobs run one at a time; a cancelled job is dropped by id, and the worker is
 * terminated only when it stops reporting progress or crashes.
 */
export class PluginGrammarWorkerClient {
  private worker: PluginGrammarWorker | null = null
  private ready = false
  private initTimer: ReturnType<typeof setTimeout> | undefined
  private active: Job | null = null
  private readonly queue: Job[] = []
  private nextId = 1
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly scopeName: string,
    private readonly grammars: readonly PluginGrammarArtifact[],
    private readonly createWorker: () => PluginGrammarWorker
  ) {}

  /** `lineLengths` comes from the model, so the main thread never re-splits the document. */
  tokenize(
    text: string,
    lineLengths: readonly number[],
    signal: AbortSignal
  ): Promise<PluginGrammarOutcome> {
    if (this.disposed || signal.aborted) {
      return Promise.resolve({ ok: false, reason: 'aborted' })
    }
    if (
      text.length > PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT ||
      lineLengths.length > PLUGIN_GRAMMAR_MODEL_LINE_LIMIT
    ) {
      return Promise.resolve({ ok: false, reason: 'size' })
    }
    return new Promise((resolve) => {
      const job: Job = { id: this.nextId++, text, lineLengths, settle: resolve, abandoned: false }
      signal.addEventListener('abort', () => this.abandon(job), { once: true })
      this.queue.push(job)
      this.startNext()
    })
  }

  dispose(): void {
    this.disposed = true
    for (const job of this.queue.splice(0)) {
      job.settle({ ok: false, reason: 'aborted' })
    }
    if (this.active) {
      this.finishActive({ ok: false, reason: 'aborted' })
    }
    this.stopWorker()
  }

  private startNext(): void {
    if (this.disposed || this.active) {
      return
    }
    const job = this.queue.shift()
    clearTimeout(this.idleTimer)
    if (!job) {
      this.idleTimer = setTimeout(() => this.stopWorker(), IDLE_WORKER_MS)
      return
    }
    try {
      const worker = this.worker ?? this.spawn()
      if (!this.ready) {
        // Why wait: setup is not progress on a document, so it has its own deadline.
        this.queue.unshift(job)
        return
      }
      this.active = job
      job.documentTimer = setTimeout(
        () => this.fail('stalled'),
        PLUGIN_GRAMMAR_DOCUMENT_DEADLINE_MS
      )
      this.armProgress(job)
      worker.postMessage({ type: 'tokenize', id: job.id, text: job.text })
    } catch {
      if (this.active !== job) {
        job.settle({ ok: false, reason: 'crashed' })
      }
      this.fail('crashed')
    }
  }

  private spawn(): PluginGrammarWorker {
    const worker = this.createWorker()
    this.worker = worker
    worker.onmessage = (event) => {
      if (this.worker === worker) {
        this.receive(event.data)
      }
    }
    worker.onerror = () => {
      if (this.worker === worker) {
        this.fail('crashed')
      }
    }
    this.ready = false
    this.initTimer = setTimeout(() => this.fail('stalled'), PLUGIN_GRAMMAR_INIT_DEADLINE_MS)
    worker.postMessage({ type: 'init', scopeName: this.scopeName, grammars: this.grammars })
    return worker
  }

  private receive(response: unknown): void {
    if (!isResponse(response)) {
      return
    }
    if (response.type === 'ready') {
      clearTimeout(this.initTimer)
      if (response.ok) {
        this.ready = true
        this.startNext()
      } else {
        this.failQueued('unavailable')
      }
      return
    }
    const job = this.active
    if (!job || response.id !== job.id) {
      return
    }
    if (response.type === 'progress') {
      this.armProgress(job)
    } else if (
      response.type === 'complete' &&
      isValidPluginGrammarTokens(response, job.lineLengths, PLUGIN_SYNTAX_TOKEN_TYPES.length)
    ) {
      this.finishActive({ ok: true, tokens: { lines: response.lines, data: response.data } })
    } else {
      this.finishActive({ ok: false, reason: 'unavailable' })
    }
  }

  private abandon(job: Job): void {
    const queued = this.queue.indexOf(job)
    if (queued !== -1) {
      this.queue.splice(queued, 1)
      job.settle({ ok: false, reason: 'aborted' })
    } else if (this.active === job && !job.abandoned) {
      // Why not terminate: the worker drops the job at its next slice and stays warm.
      job.abandoned = true
      this.worker?.postMessage({ type: 'cancel', id: job.id })
      job.settle({ ok: false, reason: 'aborted' })
    }
  }

  private armProgress(job: Job): void {
    clearTimeout(job.progressTimer)
    job.progressTimer = setTimeout(() => this.fail('stalled'), PLUGIN_GRAMMAR_PROGRESS_DEADLINE_MS)
  }

  private fail(reason: 'stalled' | 'crashed'): void {
    // Why terminate: a stuck engine keeps the worker busy forever.
    this.stopWorker()
    if (this.active) {
      this.finishActive({ ok: false, reason })
    } else {
      this.failQueued(reason)
    }
  }

  /** Setup failed, so every waiting document gets the same answer. */
  private failQueued(reason: PluginGrammarFailure): void {
    this.stopWorker()
    for (const job of this.queue.splice(0)) {
      job.settle({ ok: false, reason })
    }
  }

  private finishActive(outcome: PluginGrammarOutcome): void {
    const job = this.active
    if (!job) {
      return
    }
    clearTimeout(job.progressTimer)
    clearTimeout(job.documentTimer)
    this.active = null
    if (!job.abandoned) {
      job.settle(outcome)
    }
    queueMicrotask(() => this.startNext())
  }

  private stopWorker(): void {
    clearTimeout(this.idleTimer)
    clearTimeout(this.initTimer)
    this.ready = false
    this.worker?.terminate()
    this.worker = null
  }
}
