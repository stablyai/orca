import { subscribeRuntimeRpc } from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'
import {
  createRuntimeCrewSubscriptionAttempt,
  RuntimeCrewSetupError
} from '@/runtime/rpc/subscriptions/runtime-crew-subscribe'
import {
  CrewFrame,
  crewSummary,
  emptyCrew,
  type OrchestrationCrewRow,
  type OrchestrationCrewSnapshot,
  type OrchestrationCrewSummary
} from '../../../../shared/orchestration/orchestration-crew'
import { runtimeHostStatusBlockedReason } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { RUNTIME_COMPAT_BLOCK_CODE } from '@/runtime/rpc/compatibility/runtime-protocol-compat'
import type { CrewFollowSource } from './orchestration-crew-follow'

export const UNKNOWN_CREW = emptyCrew('unknown')

/** The counts a closed strip shows, and the rows once something asks for them. */
export type CrewState = {
  summary: OrchestrationCrewSummary
  /** Null until rows are wanted and arrive; a host that predates summaries always sends them. */
  rows: OrchestrationCrewSnapshot | null
}
export const UNKNOWN_CREW_STATE: CrewState = Object.freeze({
  summary: Object.freeze({ status: 'unknown', agents: 0, needsYou: 0 }),
  rows: null
})

type CrewSection = keyof OrchestrationCrewSnapshot['sections']
const CREW_SECTIONS = [
  'managedBy',
  'managing',
  'talkingWith'
] as const satisfies readonly CrewSection[]

/** The shown rows with a delta applied; unchanged rows keep their identity. Null when a row is missing. */
function applyCrewDelta(
  base: OrchestrationCrewSnapshot | null,
  delta: {
    status: OrchestrationCrewSnapshot['status']
    order: Record<CrewSection, string[]>
    changed: ReadonlyMap<string, OrchestrationCrewRow>
  }
): OrchestrationCrewSnapshot | null {
  if (!base) {
    return null
  }
  const next = emptyCrew(delta.status)
  for (const section of CREW_SECTIONS) {
    const held = new Map(base.sections[section].map((row) => [row.partyKey, row]))
    for (const partyKey of delta.order[section]) {
      const row = delta.changed.get(`${section}\0${partyKey}`) ?? held.get(partyKey)
      if (!row) {
        return null
      }
      next.sections[section].push(row)
    }
  }
  return next
}

export class CrewSubscription {
  snapshot: CrewState = UNKNOWN_CREW_STATE
  readonly listeners = new Set<() => void>()
  state: 'idle' | 'running' | 'waiting' | 'parked' = 'idle'
  private pending: OrchestrationCrewSnapshot | undefined
  /** A change to the shown rows: each section's order, and the rows that changed. */
  private pendingDelta:
    | {
        status: OrchestrationCrewSnapshot['status']
        order: Record<CrewSection, string[]>
        changed: Map<string, OrchestrationCrewRow>
      }
    | undefined
  private stop: (() => void) | undefined
  private started = false
  /** Readers that need rows (an open list or `@` menu); otherwise the host sends counts alone. */
  private rowReaders = 0
  private runningView: 'summary' | 'rows' | undefined

  constructor(
    readonly source: CrewFollowSource,
    readonly party: string
  ) {}

  // The host sends a frame only when its content changed, so every frame publishes.
  private publish(snapshot: CrewState): void {
    if (snapshot === this.snapshot) {
      return
    }
    this.snapshot = snapshot
    this.listeners.forEach((listener) => listener())
  }

  private view(): 'summary' | 'rows' {
    return this.rowReaders > 0 ? 'rows' : 'summary'
  }

  retire(): void {
    const stop = this.stop
    this.stop = undefined
    this.pending = undefined
    this.pendingDelta = undefined
    this.runningView = undefined
    this.state = 'parked'
    stop?.()
    this.publish(UNKNOWN_CREW_STATE)
  }

  /** Ask for rows while the caller needs them; the stream switches views, keeping what it shows. */
  wantRows = (): (() => void) => {
    this.rowReaders++
    this.switchView()
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.rowReaders--
      this.switchView()
    }
  }

  private switchView(): void {
    if (this.state !== 'running' || this.runningView === this.view()) {
      return
    }
    const stop = this.stop
    this.stop = undefined
    this.pending = undefined
    this.pendingDelta = undefined
    this.state = 'idle'
    stop?.()
    this.start()
  }

  wake(): void {
    if (this.state === 'running') {
      return
    }
    if (!this.started) {
      this.start()
    } else if (this.source.target.kind === 'local' || this.source.current.retry) {
      this.state = 'waiting'
      this.source.schedule()
    }
  }

  start(): void {
    if (this.listeners.size === 0 || this.state === 'running') {
      return
    }
    const initial = !this.started
    const source = this.source.current
    if (!(initial || this.source.target.kind === 'local' ? source.initial : source.retry)) {
      this.state = 'parked'
      return
    }
    this.started = true
    this.state = 'running'
    const view = this.view()
    this.runningView = view
    let alive = true
    let unsubscribe: (() => void) | undefined
    const stop = (): void => {
      alive = false
      unsubscribe?.()
    }
    this.stop = stop
    const fail = (error?: unknown): void => {
      if (!alive) {
        return
      }
      this.retire()
      if (error instanceof RuntimeCrewSetupError && error.fact.kind !== 'remote') {
        if (error.fact.kind !== 'operation' || error.fact.operation !== 'subscription') {
          if (error.fact.kind === 'host-unsupported') {
            this.source.block(true)
          }
          return
        }
      }
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : undefined
      if (
        code &&
        (runtimeHostStatusBlockedReason({ id: '', ok: false, error: { code, message: '' } }) ||
          code === RUNTIME_COMPAT_BLOCK_CODE ||
          code === 'runtime_environment_changed' ||
          code === 'runtime_manually_disconnected')
      ) {
        this.source.block(code === 'method_not_found' || code === 'unsupported_method')
        return
      }
      this.state = 'waiting'
      this.source.schedule()
    }
    const onEvent = (value: unknown): void => {
      if (!alive) {
        return
      }
      const parsed = CrewFrame.safeParse(value)
      if (!parsed.success) {
        fail({ code: 'invalid_runtime_response' })
        return
      }
      const frame = parsed.data
      if (frame.type === 'summary') {
        this.pending = undefined
        this.source.completed()
        const { type: _type, ...summary } = frame
        this.publish({ summary, rows: null })
      } else if (frame.type === 'begin') {
        this.pendingDelta = undefined
        this.pending = emptyCrew(frame.status)
      } else if (frame.type === 'delta') {
        this.pending = undefined
        this.pendingDelta = { status: frame.status, order: frame.order, changed: new Map() }
      } else if (frame.type === 'rows') {
        if (this.pendingDelta) {
          for (const row of frame.rows) {
            this.pendingDelta.changed.set(`${frame.section}\0${row.partyKey}`, row)
          }
        } else {
          this.pending?.sections[frame.section].push(...frame.rows)
        }
      } else if (frame.type === 'complete' && this.pendingDelta) {
        const delta = this.pendingDelta
        this.pendingDelta = undefined
        const complete = applyCrewDelta(this.snapshot.rows, delta)
        if (!complete) {
          // A change against rows this reader no longer holds: resubscribe for a whole snapshot.
          fail()
          return
        }
        this.source.completed()
        this.publish({ summary: crewSummary(complete), rows: complete })
      } else if (frame.type === 'complete' && this.pending) {
        const complete = this.pending
        this.pending = undefined
        this.source.completed()
        this.publish({ summary: crewSummary(complete), rows: complete })
      } else if (frame.type === 'end') {
        fail()
      }
    }
    let request: Promise<{ unsubscribe: () => void }>
    if (!initial && this.source.target.kind === 'environment' && source.retry) {
      const attempt = createRuntimeCrewSubscriptionAttempt(
        { ...source.retry, params: { party: this.party, view, deltas: true } },
        {
          onResponse: (response) => (response.ok ? onEvent(response.result) : fail(response.error)),
          onError: fail,
          onClose: () => fail()
        }
      )
      unsubscribe = attempt.cancel
      request = attempt.start()
    } else {
      request = subscribeRuntimeRpc(
        this.source.target,
        'orchestration.crewSubscribe',
        { party: this.party, view, deltas: true },
        { onEvent, onError: fail, onClose: () => fail() }
      )
    }
    void request.then((subscription) => {
      if (!alive) {
        subscription.unsubscribe()
      } else {
        unsubscribe = subscription.unsubscribe
      }
    }, fail)
  }

  subscribe = (listener: () => void): (() => void) => {
    const registered = () => listener()
    this.listeners.add(registered)
    this.source.retain(this)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.listeners.delete(registered)
      if (this.listeners.size === 0) {
        this.retire()
        this.source.release(this)
      }
    }
  }
  read = (): CrewState => this.snapshot
}
