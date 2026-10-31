import { subscribeRuntimeRpc } from '@/runtime/runtime-rpc-subscribe'
import {
  createRuntimeCrewSubscriptionAttempt,
  RuntimeCrewSetupError
} from '@/runtime/runtime-crew-subscribe'
import {
  CrewFrame,
  emptyCrew,
  type OrchestrationCrewSnapshot
} from '../../../../shared/orchestration-crew'
import { runtimeHostStatusBlockedReason } from '../../../../shared/runtime-host-status'
import { RUNTIME_COMPAT_BLOCK_CODE } from '@/runtime/runtime-protocol-compat'
import type { CrewFollowSource } from './orchestration-crew-follow'

export const UNKNOWN_CREW = emptyCrew('unknown')

export class CrewSubscription {
  snapshot = UNKNOWN_CREW
  readonly listeners = new Set<() => void>()
  state: 'idle' | 'running' | 'waiting' | 'parked' = 'idle'
  private pending: OrchestrationCrewSnapshot | undefined
  private stop: (() => void) | undefined
  private started = false

  constructor(
    readonly source: CrewFollowSource,
    readonly party: string
  ) {}

  private publish(snapshot: OrchestrationCrewSnapshot): void {
    if (JSON.stringify(this.snapshot) === JSON.stringify(snapshot)) {
      return
    }
    this.snapshot = snapshot
    this.listeners.forEach((listener) => listener())
  }

  retire(): void {
    const stop = this.stop
    this.stop = undefined
    this.pending = undefined
    this.state = 'parked'
    stop?.()
    this.publish(UNKNOWN_CREW)
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
      if (frame.type === 'begin') {
        this.pending = emptyCrew(frame.status)
      } else if (frame.type === 'rows') {
        this.pending?.sections[frame.section].push(...frame.rows)
      } else if (frame.type === 'complete' && this.pending) {
        const complete = this.pending
        this.pending = undefined
        this.source.completed()
        this.publish(complete)
      } else if (frame.type === 'end') {
        fail()
      }
    }
    let request: Promise<{ unsubscribe: () => void }>
    if (!initial && this.source.target.kind === 'environment' && source.retry) {
      const attempt = createRuntimeCrewSubscriptionAttempt(
        { ...source.retry, params: { party: this.party } },
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
        { party: this.party },
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
  read = (): OrchestrationCrewSnapshot => this.snapshot
}
