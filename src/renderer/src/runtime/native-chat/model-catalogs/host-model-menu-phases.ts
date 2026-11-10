import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'

type PhaseResult = {
  answer?: AgentSessionModelCatalogResult
  reply?: AgentSessionModelCatalogResult
  waited?: boolean
  waiting?: Phase
}
type Claim = {
  generation: number
  signal: AbortSignal
  end: () => void
  withdraw?: () => void
}
type Phase = {
  waited: boolean
  generation: number
  completion: ReturnType<typeof Promise.withResolvers<PhaseResult>>
  callers: Map<Claim, (result: PhaseResult) => void>
  settled?: boolean
}

export class HostModelMenuPhases {
  private generation = 0
  private claims = new Set<Claim>()
  private physical = new Set<Phase>()
  private active?: Phase
  private queued?: Phase
  constructor(
    private readonly perform: (waited: boolean, current: () => boolean) => Promise<PhaseResult>,
    private readonly provisional: () => AgentSessionModelCatalogResult,
    private readonly reuse: () => PhaseResult | undefined,
    private readonly changed: () => void
  ) {}
  get pending() {
    return this.active !== undefined
  }
  get busy() {
    return this.claims.size > 0 || this.physical.size > 0 || this.queued !== undefined
  }
  invalidate() {
    const claims = [...this.claims]
    this.generation++
    this.active = undefined
    const queued = this.queued
    this.queued = undefined
    if (queued) {
      this.complete(queued, {})
    }
    for (const claim of claims) {
      claim.end()
    }
  }
  async read(reuseHeld: boolean, waitForListing: boolean | undefined, signal: AbortSignal) {
    if (signal.aborted) {
      return undefined
    }
    const claim: Claim = {
      generation: this.generation,
      signal,
      end: () => {
        if (!this.claims.delete(claim)) {
          return
        }
        claim.withdraw?.()
        signal.removeEventListener('abort', claim.end)
        this.changed()
      }
    }
    this.claims.add(claim)
    signal.addEventListener('abort', claim.end, { once: true })
    try {
      const initial = this.phase(claim, waitForListing ?? false, reuseHeld)
      let result = await (waitForListing === undefined && 'waiting' in initial && initial.waiting
        ? this.join(initial.waiting, claim)
        : initial)
      while (
        waitForListing === undefined &&
        this.live(claim) &&
        result.reply?.listingInProgress &&
        (!result.waited || result.reply.waitExpired)
      ) {
        result = await this.phase(claim, true, false)
      }
      return this.live(claim) ? result.answer : undefined
    } finally {
      claim.end()
    }
  }
  private live(claim: Claim) {
    return !claim.signal.aborted && claim.generation === this.generation && this.claims.has(claim)
  }
  private phase(
    claim: Claim,
    waited: boolean,
    reuseHeld: boolean
  ): PhaseResult | Promise<PhaseResult> {
    if (!this.live(claim)) {
      return {}
    }
    if (this.active) {
      if (this.active.waited && !waited) {
        return { answer: this.provisional(), waiting: this.active }
      }
      if (!this.active.waited && waited) {
        this.queued ??= this.create(true)
        return this.join(this.queued, claim)
      }
      return this.join(this.active, claim)
    }
    const held = reuseHeld && !waited ? this.reuse() : undefined
    if (held) {
      return held
    }
    const phase = this.create(waited)
    const result = this.join(phase, claim)
    this.start(phase)
    return result
  }
  private create(waited: boolean): Phase {
    return {
      waited,
      generation: this.generation,
      completion: Promise.withResolvers<PhaseResult>(),
      callers: new Map()
    }
  }
  private join(phase: Phase, claim: Claim): Promise<PhaseResult> {
    if (!this.live(claim) || phase.generation !== this.generation) {
      return Promise.resolve({})
    }
    if (phase.settled) {
      return phase.completion.promise
    }
    return new Promise((resolve) => {
      const finish = (result: PhaseResult) => {
        phase.callers.delete(claim)
        claim.withdraw = undefined
        resolve(result)
      }
      phase.callers.set(claim, finish)
      claim.withdraw = () => {
        phase.callers.delete(claim)
        claim.withdraw = undefined
        if (this.physical.has(phase)) {
          void phase.completion.promise.then(() => resolve({}))
        } else {
          resolve({})
        }
        if (this.queued === phase && !phase.callers.size) {
          this.queued = undefined
          this.complete(phase, {})
        }
      }
    })
  }
  private complete(phase: Phase, result: PhaseResult) {
    phase.settled = true
    phase.completion.resolve(result)
    for (const finish of phase.callers.values()) {
      finish(result)
    }
  }
  private start(phase: Phase) {
    this.active = phase
    this.physical.add(phase)
    this.changed()
    void Promise.resolve()
      .then(() =>
        phase.generation === this.generation && [...phase.callers.keys()].some((c) => this.live(c))
          ? this.perform(phase.waited, () => phase.generation === this.generation)
          : {}
      )
      .catch(() => ({}))
      .then((result) => {
        this.physical.delete(phase)
        if (this.active === phase) {
          this.active = undefined
          const queued = this.queued
          if (queued) {
            this.start(queued)
            this.queued = undefined
          }
        }
        this.complete(phase, result)
        this.changed()
      })
  }
}
