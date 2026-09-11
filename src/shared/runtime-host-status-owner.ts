import {
  isRuntimeHostStatusBlocked,
  runtimeHostStatusError,
  runtimeHostStatusFailure,
  type RuntimeHostStatusResponse,
  type RuntimeHostStatusSnapshot
} from './runtime-host-status'

const RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 30_000, 60_000]
const REQUEST_TIMEOUT_MS = 15_000
let publicationSequence = 0

type Waiter = {
  resolve: (response: RuntimeHostStatusResponse) => void
  cleanup: () => void
}

type StatusOwnerOptions = {
  environmentId: string
  pairingRevision: number
  persistent?: boolean
  request: (signal: AbortSignal) => Promise<RuntimeHostStatusResponse>
  verified: (response: Extract<RuntimeHostStatusResponse, { ok: true }>, active: boolean) => boolean
  publish: (snapshot: RuntimeHostStatusSnapshot) => void
}

/** One verification and one retry slot, shared by all readers of this connection. */
export class RuntimeHostStatusOwner {
  private active = false
  private disposed = false
  private persistent: boolean
  private attempt = 0
  private retry: ReturnType<typeof setTimeout> | null = null
  private request: AbortController | null = null
  private readonly waiters = new Set<Waiter>()
  private response: RuntimeHostStatusResponse = runtimeHostStatusFailure(
    'runtime_unavailable',
    'Status has not been checked.'
  )
  private snapshot: RuntimeHostStatusSnapshot

  constructor(private readonly options: StatusOwnerOptions) {
    this.persistent = options.persistent ?? false
    this.snapshot = {
      environmentId: options.environmentId,
      pairingRevision: options.pairingRevision,
      sequence: ++publicationSequence,
      checkedAt: 0,
      status: null,
      verification: 'checking',
      transport: 'unknown'
    }
  }

  read(): RuntimeHostStatusSnapshot {
    return this.snapshot
  }

  activate(): void {
    if (this.active || this.disposed) {
      return
    }
    this.active = true
    this.startRequest()
  }

  acceptVerified(response: Extract<RuntimeHostStatusResponse, { ok: true }>): void {
    if (this.disposed) {
      return
    }
    this.active = true
    this.retireRequest()
    this.clearRetry()
    this.complete(response)
  }

  refresh(
    options: { timeoutMs?: number; observeOnly?: true; reconnect?: true; signal?: AbortSignal } = {}
  ): Promise<RuntimeHostStatusResponse> {
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason)
    }
    if (this.disposed) {
      return Promise.resolve(this.response)
    }
    if (!options.observeOnly) {
      this.active = true
    }
    if (options.reconnect) {
      this.attempt = 0
      this.update({ verification: 'checking' })
    }
    if (this.snapshot.verification === 'blocked') {
      return Promise.resolve(this.response)
    }
    const result = new Promise<RuntimeHostStatusResponse>((resolve, reject) => {
      const release = (): void => {
        waiter.cleanup()
        this.waiters.delete(waiter)
        if (!this.active && this.waiters.size === 0) {
          this.retireRequest()
        }
      }
      const abort = (): void => {
        release()
        reject(options.signal?.reason)
      }
      const timer = setTimeout(() => {
        release()
        resolve(
          runtimeHostStatusFailure(
            'runtime_unavailable',
            this.snapshot.transport === 'ready'
              ? 'Status request timed out.'
              : 'Timed out waiting for the remote Orca runtime.'
          )
        )
      }, options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      const waiter: Waiter = {
        resolve,
        cleanup: () => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', abort)
        }
      }
      this.waiters.add(waiter)
      options.signal?.addEventListener('abort', abort, { once: true })
    })
    this.startRequest()
    return result
  }

  connectionChanged(
    transport: RuntimeHostStatusSnapshot['transport'],
    remoteControl?: RuntimeHostStatusSnapshot['remoteControl']
  ): void {
    if (this.disposed) {
      return
    }
    const previous = this.snapshot.transport
    this.update({ transport, ...(remoteControl !== undefined ? { remoteControl } : {}) })
    if (transport === previous) {
      return
    }
    if (previous === 'ready') {
      this.retireRequest()
      this.clearRetry()
      if (this.snapshot.verification !== 'blocked') {
        this.update({ verification: 'unavailable' })
      }
    }
    if (transport === 'ready' && this.snapshot.verification !== 'blocked') {
      // A pre-reconnect answer cannot verify the new socket's runtime.
      this.retireRequest()
      if (this.active || this.waiters.size > 0) {
        this.startRequest()
      }
    }
  }

  authenticationRejected(): void {
    if (this.disposed) {
      return
    }
    this.retireRequest()
    this.clearRetry()
    this.complete(runtimeHostStatusFailure('unauthorized', 'Pair this client again.'))
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.active = false
    this.retireRequest()
    this.clearRetry()
    this.response = runtimeHostStatusFailure(
      'runtime_manually_disconnected',
      'Runtime environment was disconnected or replaced.'
    )
    this.update({ retired: true, transport: 'disconnected', verification: 'blocked' })
    this.settleWaiters()
  }

  private startRequest(): void {
    if (this.disposed || this.request || this.snapshot.verification === 'blocked') {
      return
    }
    this.clearRetry()
    const controller = new AbortController()
    this.request = controller
    if (this.snapshot.verification !== 'verified') {
      this.update({ verification: 'checking' })
    }
    void this.verify(controller)
  }

  private async verify(controller: AbortController): Promise<void> {
    let response: RuntimeHostStatusResponse
    try {
      response = await this.options.request(controller.signal)
    } catch (error) {
      response = runtimeHostStatusError(error)
      if (error instanceof TypeError || error instanceof SyntaxError) {
        console.error('Runtime status verification failed:', error)
        response = runtimeHostStatusFailure('invalid_runtime_response', error.message)
      }
    }
    if (this.request !== controller || this.disposed) {
      return
    }
    this.request = null
    this.complete(response)
  }

  private complete(response: RuntimeHostStatusResponse): void {
    this.response = response
    if (response.ok) {
      this.attempt = 0
      this.update({
        status: response.result,
        checkedAt: Date.now(),
        verification: 'verified',
        blockedCode: undefined
      })
      this.persistent = this.options.verified(response, this.active)
    } else {
      const blocked = isRuntimeHostStatusBlocked(response)
      this.update({
        checkedAt: Date.now(),
        verification: blocked ? 'blocked' : 'unavailable',
        blockedCode: blocked ? response.error.code : undefined
      })
      this.scheduleRetry()
    }
    this.settleWaiters()
  }

  private scheduleRetry(): void {
    if (
      !this.active ||
      this.disposed ||
      this.snapshot.verification === 'blocked' ||
      (this.persistent && this.snapshot.transport !== 'ready')
    ) {
      return
    }
    const delay = RETRY_DELAYS_MS[Math.min(this.attempt++, RETRY_DELAYS_MS.length - 1)]
    this.retry = setTimeout(() => {
      this.retry = null
      this.startRequest()
    }, delay)
  }

  private settleWaiters(): void {
    for (const waiter of this.waiters) {
      waiter.cleanup()
      waiter.resolve(this.response)
    }
    this.waiters.clear()
  }

  private retireRequest(): void {
    const request = this.request
    this.request = null
    request?.abort()
  }

  private clearRetry(): void {
    if (this.retry) {
      clearTimeout(this.retry)
    }
    this.retry = null
  }

  private update(patch: Partial<RuntimeHostStatusSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, sequence: ++publicationSequence }
    this.options.publish(this.snapshot)
  }
}
