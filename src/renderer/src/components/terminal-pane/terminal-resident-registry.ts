import { TerminalSnapshotConsumption } from '../../../../shared/terminal-snapshot-consumption'
import type { TerminalSideEffectBatch } from '../../../../shared/terminal-side-effect-facts'
import type { TerminalFactSubject } from './terminal-fact-subject'
import type {
  TerminalSnapshotEffect,
  TerminalTransientCurrent,
  TerminalTransientObservation
} from '../../../../shared/terminal-transient-observation'

export type TerminalResidentIdentity = {
  endpoint: string
  executionHost: string
  runtimeId: string | null
  ptyId: string
  incarnationId: string | null
}

export type TerminalResidentPolicy = {
  restoreCurrent: (
    current: TerminalTransientCurrent,
    first: boolean,
    complete?: boolean,
    subject?: TerminalFactSubject | null,
    liveEffects?: readonly TerminalSnapshotEffect[]
  ) => void
  applyEffect: (
    effect: TerminalSnapshotEffect,
    current: TerminalTransientCurrent,
    subject?: TerminalFactSubject | null
  ) => void
  observePrLink: (url: string) => void
  dispose: () => void
}

/** An execution owns policy; a mounted terminal is only a replaceable presentation port. */
export class TerminalResident<Policy extends TerminalResidentPolicy> {
  private consumption = new TerminalSnapshotConsumption()
  readonly policy: Policy
  private ended = false
  private readonly endListeners = new Set<(captured: TerminalResident<Policy>) => void>()

  constructor(
    private physicalIdentity: Readonly<TerminalResidentIdentity>,
    createPolicy: (resident: TerminalResident<Policy>) => Policy
  ) {
    this.policy = createPolicy(this)
  }

  get isLive(): boolean {
    return !this.ended
  }

  get identity(): Readonly<TerminalResidentIdentity> {
    return this.physicalIdentity
  }

  onEnd(listener: (captured: TerminalResident<Policy>) => void): () => void {
    if (this.ended) {
      listener(this)
      return () => {}
    }
    this.endListeners.add(listener)
    return () => {
      this.endListeners.delete(listener)
    }
  }

  installSource(batch: TerminalSideEffectBatch): boolean {
    const source = batch.terminalState
    if (
      this.ended ||
      !source ||
      (this.identity.incarnationId !== null && this.identity.incarnationId !== source.incarnationId)
    ) {
      return false
    }
    if (this.identity.runtimeId === source.runtimeId) {
      return true
    }
    this.physicalIdentity = Object.freeze({
      ...this.identity,
      runtimeId: source.runtimeId,
      incarnationId: source.incarnationId
    })
    const live = this.consumption.install(
      source.snapshot,
      batch.replay
        ? undefined
        : batch.facts.map((fact) =>
            fact.kind === 'pr-link' ? { kind: 'pr-link', url: fact.link.url } : fact
          )
    )
    this.policy.restoreCurrent(source.snapshot.current, true, true, undefined, live.effects)
    for (const effect of live.effects) {
      this.policy.applyEffect(effect, source.snapshot.current)
    }
    for (const link of live.links) {
      this.policy.observePrLink(link.url)
    }
    return true
  }

  admitIdentity(identity: TerminalResidentIdentity): boolean {
    if (
      this.ended ||
      (this.identity.runtimeId !== null &&
        identity.runtimeId !== null &&
        this.identity.runtimeId !== identity.runtimeId) ||
      (this.identity.incarnationId !== null &&
        identity.incarnationId !== null &&
        this.identity.incarnationId !== identity.incarnationId)
    ) {
      return false
    }
    if (
      this.identity.runtimeId !== identity.runtimeId ||
      this.identity.incarnationId !== identity.incarnationId
    ) {
      this.physicalIdentity = Object.freeze({
        ...this.identity,
        runtimeId: this.identity.runtimeId ?? identity.runtimeId,
        incarnationId: this.identity.incarnationId ?? identity.incarnationId
      })
    }
    return true
  }

  consume(batch: TerminalSideEffectBatch, subject?: TerminalFactSubject): void {
    if (
      this.ended ||
      !batch.terminalState ||
      !this.admitIdentity({
        ...this.identity,
        runtimeId: batch.terminalState.runtimeId,
        incarnationId: batch.terminalState.incarnationId
      })
    ) {
      return
    }
    this.consumeSnapshot(
      batch.terminalState.snapshot,
      this.policy.applyEffect,
      true,
      batch.replay
        ? undefined
        : batch.facts.map((fact) =>
            fact.kind === 'pr-link' ? { kind: 'pr-link', url: fact.link.url } : fact
          ),
      subject
    )
  }

  consumeSnapshot(
    snapshot: TerminalTransientObservation,
    applyEffect = this.policy.applyEffect,
    complete = true,
    liveFacts?: Parameters<TerminalSnapshotConsumption['consumeLive']>[1],
    subject?: TerminalFactSubject
  ): void {
    if (this.ended) {
      return
    }
    const consumed = liveFacts
      ? this.consumption.consumeLive(snapshot, liveFacts)
      : this.consumption.consume(snapshot)
    if (!consumed) {
      return
    }
    const current = snapshot.current
    for (const effect of consumed.effects) {
      const eligible = subject?.isCurrent()
      applyEffect(effect, current, subject)
      if (eligible) {
        subject = subject?.captureCurrent()
      }
    }
    for (const link of consumed.links) {
      this.policy.observePrLink(link.url)
    }
    this.policy.restoreCurrent(
      current,
      consumed.first && liveFacts === undefined,
      complete,
      subject
    )
  }

  dispose(): void {
    if (this.ended) {
      return
    }
    this.ended = true
    this.policy.dispose()
    const listeners = [...this.endListeners]
    this.endListeners.clear()
    for (const listener of listeners) {
      listener(this)
    }
  }
}

export class TerminalResidentRegistry<Policy extends TerminalResidentPolicy> {
  private readonly residents = new Map<string, TerminalResident<Policy>>()

  private key(
    identity: Pick<TerminalResidentIdentity, 'endpoint' | 'executionHost' | 'ptyId'>
  ): string {
    return JSON.stringify([identity.endpoint, identity.executionHost, identity.ptyId])
  }

  admit(
    identity: TerminalResidentIdentity,
    createPolicy: (resident: TerminalResident<Policy>) => Policy
  ): TerminalResident<Policy> {
    const key = this.key(identity)
    const existing = this.residents.get(key)
    if (existing?.admitIdentity(identity)) {
      return existing
    }
    if (existing) {
      return existing
    }
    const resident = new TerminalResident(Object.freeze({ ...identity }), createPolicy)
    this.residents.set(key, resident)
    return resident
  }

  retire(resident: TerminalResident<Policy>): void {
    if (this.residents.get(this.key(resident.identity)) !== resident) {
      return
    }
    this.residents.delete(this.key(resident.identity))
    resident.dispose()
  }

  dispose(): void {
    for (const resident of this.residents.values()) {
      resident.dispose()
    }
    this.residents.clear()
  }
}
