import { TerminalSnapshotObserver } from '../../../../shared/terminal-snapshot-observer'
import { TerminalSnapshotConsumption } from '../../../../shared/terminal-snapshot-consumption'
import type { TerminalSideEffectBatch } from '../../../../shared/terminal-side-effect-facts'
import type { TerminalResidentPolicy } from './terminal-resident-registry'
import type { PtyDataMeta } from './pty-dispatcher'
import type { TerminalResidentBinding } from './terminal-resident-policy'
import { readInFlightCommandCodeTurn } from './terminal-command-code-status-policy'
import { captureTerminalFactSubject, type TerminalFactSubject } from './terminal-fact-subject'

/** One parser and counter lifetime accepts whichever legacy delivery owns genuine output. */
export class TerminalResidentLegacySource {
  private readonly bytes: TerminalSnapshotObserver
  private readonly consumption = new TerminalSnapshotConsumption()
  private rawEndSeq = 0
  private lastLiveTitleSeq: number | null = null
  private subject: TerminalFactSubject | null = null
  private readonly paneKey: string
  private readonly acceptsUnqualifiedFacts: boolean
  byteSource = false

  constructor(binding: TerminalResidentBinding, policy: TerminalResidentPolicy) {
    this.paneKey = binding.paneKey
    this.acceptsUnqualifiedFacts = binding.runtimeEnvironmentId != null
    this.byteSource = binding.runtimeEnvironmentId != null
    this.bytes = new TerminalSnapshotObserver(
      (snapshot, delivery = 'bytes') => {
        const consumed = this.consumption.consume(snapshot)
        if (!consumed) {
          return
        }
        const ownsEffects =
          this.byteSource === (delivery === 'bytes') ||
          (delivery === 'facts' && this.acceptsUnqualifiedFacts)
        for (const effect of consumed.effects) {
          if (ownsEffects || (delivery === 'bytes' && effect.fact.kind === 'command-started')) {
            const currentSubject = this.subject?.isCurrent() === true
            policy.applyEffect(effect, snapshot.current, this.subject)
            if (currentSubject) {
              this.subject = captureTerminalFactSubject(this.paneKey)
            }
          }
        }
        if (!ownsEffects) {
          return
        }
        for (const link of consumed.links) {
          policy.observePrLink(link.url)
        }
        policy.restoreCurrent(snapshot.current, consumed.first, false, this.subject)
      },
      {
        adopted: true,
        startupCommand: binding.startup?.command,
        initialTitle: binding.initialTitle,
        inFlightTurn: readInFlightCommandCodeTurn(binding.paneKey),
        publishEachFact: true
      }
    )
    const snapshot = this.bytes.snapshot()
    this.consumption.consume(snapshot)
  }

  observeData(data: string, meta?: PtyDataMeta, subject?: TerminalFactSubject | null): void {
    if (meta?.droppedOutput) {
      return
    }
    const end = meta?.seq ?? this.rawEndSeq + (meta?.rawLength ?? data.length)
    if (meta?.seq !== undefined && end <= this.rawEndSeq) {
      return
    }
    const rawLength = meta?.rawLength ?? data.length
    const overlap = this.rawEndSeq - (end - rawLength)
    if (overlap > 0 && !meta?.transformed && rawLength === data.length) {
      data = data.slice(overlap)
    }
    this.rawEndSeq = end
    this.subject = subject === undefined ? captureTerminalFactSubject(this.paneKey) : subject
    this.bytes.observe(data, end)
  }

  observeFacts(batch: TerminalSideEffectBatch, subject?: TerminalFactSubject | null): void {
    if (
      (this.byteSource && !this.acceptsUnqualifiedFacts) ||
      (batch.replay && this.lastLiveTitleSeq !== null && batch.seq <= this.lastLiveTitleSeq)
    ) {
      return
    }
    for (const fact of batch.facts) {
      if (batch.replay && fact.kind !== 'title') {
        continue
      }
      if (!batch.replay && fact.kind === 'title') {
        this.lastLiveTitleSeq = batch.seq
      }
      this.subject = subject === undefined ? captureTerminalFactSubject(this.paneKey) : subject
      this.bytes.observeFact(
        fact.kind === 'pr-link' ? { kind: 'pr-link', url: fact.link.url } : fact,
        batch.seq
      )
    }
  }

  dispose(): void {
    this.bytes.dispose()
  }
}
