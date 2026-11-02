import { createTerminalTitleTracker } from './terminal-output-side-effects'
import { createTerminalAgentStatusProcessor } from './terminal-agent-status-processor'
import { createCommandCodeOutputStatusDetector } from './command-code-output-status'
import { extractOscTitleScanTail } from './osc-title-scan-tail'
import { TerminalSnapshotState } from './terminal-snapshot-state'
import type {
  TerminalTransientFact,
  TerminalTransientObservation
} from './terminal-transient-observation'

/** Genuine output interpretation belongs to the physical execution, before display loss. */
export class TerminalSnapshotObserver {
  private readonly accumulator: TerminalSnapshotState
  private get state(): TerminalTransientObservation {
    return this.accumulator.state
  }
  private titleTail = ''
  private readonly status = createTerminalAgentStatusProcessor()
  private readonly tracker
  private readonly commandCode
  private observing = false
  private readonly publishEachFact: boolean

  constructor(
    private readonly publish: (
      observation: TerminalTransientObservation,
      delivery?: 'bytes' | 'facts'
    ) => void,
    options: {
      adopted?: boolean
      startupCommand?: string
      initialTitle?: string
      inFlightTurn?: { prompt: string } | null
      publishEachFact?: boolean
    } = {}
  ) {
    this.accumulator = new TerminalSnapshotState(options.adopted)
    this.publishEachFact = options.publishEachFact === true
    this.tracker = createTerminalTitleTracker(
      {
        onCommandStarted: () => {
          this.record({ kind: 'command-started' })
        },
        onCommandFinished: (exitCode) => {
          this.record({ kind: 'command-finished', exitCode })
        },
        onTitle: (normalizedTitle, rawTitle, meta) =>
          this.record({ kind: 'title', normalizedTitle, rawTitle, ...meta }),
        onAgentBecameWorking: () => this.record({ kind: 'agent-working' }),
        onAgentBecameIdle: (title, meta) => this.record({ kind: 'agent-idle', title, ...meta }),
        onAgentExited: () => this.record({ kind: 'agent-exited' }),
        onProgramActivity: (activity) => {
          if (this.state.current.activity !== activity) {
            this.state.current.activity = activity
            this.state.revision++
          }
        },
        onBell: () => this.record({ kind: 'bell' }),
        onPrLink: (link) => this.record({ kind: 'pr-link', url: link.url }),
        onMode2031Subscribe: () => this.record({ kind: '2031-subscribe' }),
        onMode2031Unsubscribe: () => this.record({ kind: '2031-unsubscribe' })
      },
      { initialTitle: options.initialTitle }
    )
    this.commandCode = createCommandCodeOutputStatusDetector({
      startupCommand: options.startupCommand,
      inFlightTurn: options.inFlightTurn,
      onWorking: (prompt) => this.record({ kind: 'command-code-working', prompt }),
      onDone: (prompt) => this.record({ kind: 'command-code-done', prompt })
    })
    this.state.current.commandCode = {
      ...this.state.current.commandCode,
      ...this.commandCode.getState()
    }
    if (options.initialTitle) {
      this.accumulator.record({
        kind: 'title',
        rawTitle: options.initialTitle,
        normalizedTitle: options.initialTitle
      })
    }
  }

  record(fact: TerminalTransientFact): void {
    this.accumulator.record(fact)
    if (!this.observing || this.publishEachFact) {
      this.publish(this.snapshot())
    }
  }

  observeFact(fact: TerminalTransientFact, rawEndSeq: number): void {
    this.state.rawEndSeq = rawEndSeq
    if (fact.kind === 'title') {
      this.tracker.restoreCurrent(fact.rawTitle, this.state.current.activity)
    }
    if (fact.kind === 'command-code-working' || fact.kind === 'command-code-done') {
      this.commandCode.observeTurn(fact.prompt)
    }
    this.accumulator.record(fact)
    this.publish(this.snapshot(), 'facts')
  }

  observe(data: string, rawEndSeq: number): void {
    const before = this.state.revision
    this.state.rawEndSeq = rawEndSeq
    this.observing = true
    try {
      const chunk = this.status(data)
      for (const payload of chunk.payloads) {
        this.record({
          kind: 'agent-status',
          payload,
          ...(chunk.programStatusPayloads?.has(payload) ? { fromProgramStatus: true } : {}),
          ...(chunk.programStatusRowRemovals?.has(payload) ? { removesProgramStatusRow: true } : {})
        })
      }
      const titles = this.titleTail + chunk.cleanData
      this.titleTail = extractOscTitleScanTail(titles)
      this.tracker.handleChunk(chunk.cleanData, {
        commandScanData: data,
        titleScanData: titles,
        programActivity: chunk.programActivity
      })
      if (chunk.programStatusFacet !== undefined) {
        this.record({
          kind: 'program-facet',
          facet: chunk.programStatusFacet,
          activity: this.state.current.activity
        })
      }
      this.commandCode.observe(chunk.cleanData)
      const commandCode = this.commandCode.getState()
      if (
        commandCode.armed !== this.state.current.commandCode.armed ||
        commandCode.prompt !== this.state.current.commandCode.prompt
      ) {
        this.state.current.commandCode = { ...this.state.current.commandCode, ...commandCode }
        this.state.revision++
      }
    } finally {
      this.observing = false
    }
    if (before !== this.state.revision) {
      this.publish(this.snapshot())
    }
  }

  snapshot(): TerminalTransientObservation {
    return this.accumulator.snapshot()
  }
  dispose(): void {
    this.tracker.dispose()
  }
}
