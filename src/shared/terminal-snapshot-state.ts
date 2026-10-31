import {
  terminalEffectKey,
  type TerminalTransientFact,
  type TerminalTransientObservation
} from './terminal-transient-observation'

/** Bounded current evidence and latest payload per effect; never a retained event journal. */
export class TerminalSnapshotState {
  readonly state: TerminalTransientObservation
  constructor(adopted = false) {
    this.state = {
      kind: 'snapshot',
      revision: 0,
      rawEndSeq: 0,
      current: {
        command: adopted ? 'uncertain' : 'unseen',
        commandRevision: 0,
        commandOrdinal: 0,
        mode2031: 'unknown',
        modeRevision: 0,
        title: null,
        activity: null,
        program: null,
        inBandStatus: null,
        commandCode: { armed: false, prompt: '', phase: 'unseen', turnOrdinal: 0, observedAt: 0 }
      },
      effects: {},
      recentPrLinks: []
    }
  }
  record(fact: TerminalTransientFact, observedAt = Date.now(), commandOrdinal?: number): void {
    const revision = ++this.state.revision
    const current = this.state.current
    switch (fact.kind) {
      case 'command-started':
        current.commandOrdinal = commandOrdinal ?? current.commandOrdinal + 1
        current.command = 'running'
        current.commandRevision = revision
        break
      case 'command-finished':
        current.command = 'prompt'
        current.commandRevision = revision
        break
      case '2031-subscribe':
        current.mode2031 = 'subscribed'
        current.modeRevision = revision
        break
      case '2031-unsubscribe':
        current.mode2031 = 'unsubscribed'
        current.modeRevision = revision
        break
      case 'title':
        current.title = { ...fact, observedAt }
        break
      case 'agent-working':
        current.activity = 'working'
        break
      case 'agent-idle':
        if (!fact.staleWorkingTitleClear) {
          current.activity = fact.status ?? 'idle'
        }
        break
      case 'agent-exited':
        current.activity = null
        break
      case 'agent-status':
        if (fact.fromProgramStatus) {
          current.program = {
            payload: fact.payload,
            facet: current.program?.facet ?? null,
            activity: current.activity,
            removesRow: fact.removesProgramStatusRow === true,
            observedAt
          }
        } else {
          current.inBandStatus = { payload: fact.payload, observedAt }
        }
        break
      case 'program-facet':
        current.program = {
          payload: current.program?.payload ?? null,
          facet: fact.facet,
          activity: fact.activity,
          removesRow: current.program?.removesRow ?? false,
          observedAt
        }
        break
      case 'command-code-working':
      case 'command-code-done':
        if (fact.kind === 'command-code-working' && current.commandCode.phase !== 'working') {
          current.commandCode.turnOrdinal++
        }
        current.commandCode = {
          ...current.commandCode,
          armed: true,
          prompt: fact.prompt,
          phase: fact.kind === 'command-code-working' ? 'working' : 'done',
          observedAt
        }
        break
      case 'bell':
        break
      case 'pr-link':
        this.state.recentPrLinks = [
          ...this.state.recentPrLinks.filter((link) => link.url !== fact.url),
          { url: fact.url, order: revision, observedAt }
        ].slice(-8)
        break
    }
    const key = terminalEffectKey(fact)
    if (key && !(fact.kind === 'agent-idle' && fact.staleWorkingTitleClear)) {
      this.state.effects[key] = {
        count: (this.state.effects[key]?.count ?? 0) + 1,
        order: revision,
        observedAt,
        commandOrdinal: commandOrdinal ?? current.commandOrdinal,
        fact
      }
    }
  }
  snapshot(): TerminalTransientObservation {
    return structuredClone(this.state)
  }
}
