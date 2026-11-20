import {
  BrowserClientPageRendererOutcome,
  BrowserClientPageRendererRequest,
  type BrowserClientPageRendererOutcome as RendererOutcome,
  type BrowserClientPageRendererRequest as RendererRequest
} from '../../../shared/browser/client-hosting/browser-client-page-renderer-protocol'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/identifiers/non-secure-context-uuid'

export type TauriRendererRequestCallback = (
  request: RendererRequest
) => RendererOutcome | Promise<RendererOutcome>

// Why distributed: Omit over the whole union loses per-member excess-property
// checks, so a rekeyPage input's nextPage is rejected. One Omit per member
// keeps the discriminator working; the zod parse below still guards runtime.
export type TauriRendererRequestInput =
  | Omit<Extract<RendererRequest, { type: 'mountPage' }>, 'requestId'>
  | Omit<Extract<RendererRequest, { type: 'retirePage' }>, 'requestId'>
  | Omit<Extract<RendererRequest, { type: 'rekeyPage' }>, 'requestId'>

type PendingRequest = {
  request: RendererRequest
  subscriberGeneration: number | null
  timer: ReturnType<typeof setTimeout>
  resolve: (outcome: RendererOutcome) => void
}

const MAX_PENDING = 512
const REQUEST_TIMEOUT_MS = 10_000

function outcomeMatchesRequest(outcome: RendererOutcome, request: RendererRequest): boolean {
  return (
    outcome.type === 'failed' ||
    (request.type === 'mountPage' && outcome.type === 'mounted') ||
    (request.type === 'retirePage' && outcome.type === 'retired') ||
    (request.type === 'rekeyPage' && outcome.type === 'rekeyed')
  )
}

function createRequestId(): string {
  return createBrowserUuid()
}

// Local equivalent of the Electron preload renderer-request bus. The Tauri
// host and the retained registry share one JS context, so mount/retire
// requests never cross IPC; queueing and timeout stay aligned instead.
class TauriBrowserClientPageRendererBus {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly queuedRequestIds: string[] = []
  private callback: TauriRendererRequestCallback | null = null
  private subscriberGeneration = 0

  subscribe = (callback: TauriRendererRequestCallback): (() => void) => {
    if (typeof callback !== 'function') {
      throw new Error('browser_client_page_renderer_subscriber_invalid')
    }
    const replacedGeneration = this.callback ? this.subscriberGeneration : null
    const generation = ++this.subscriberGeneration
    this.callback = callback
    if (replacedGeneration !== null) {
      this.failSubscriberRequests(
        replacedGeneration,
        'browser_client_page_renderer_subscriber_replaced'
      )
    }
    for (const requestId of this.queuedRequestIds.splice(0)) {
      this.dispatch(requestId, generation, callback)
    }
    return () => {
      if (this.callback !== callback || this.subscriberGeneration !== generation) {
        return
      }
      this.callback = null
      this.failSubscriberRequests(generation, 'browser_client_page_renderer_subscriber_unavailable')
    }
  }

  request(input: TauriRendererRequestInput): Promise<RendererOutcome> {
    const parsed = BrowserClientPageRendererRequest.safeParse({
      ...input,
      requestId: createRequestId()
    })
    if (!parsed.success) {
      return Promise.resolve({
        type: 'failed',
        errorCode: 'browser_client_page_renderer_request_invalid'
      })
    }
    const request = parsed.data
    if (this.pending.has(request.requestId)) {
      return Promise.resolve({
        type: 'failed',
        errorCode: 'browser_client_page_renderer_request_id_conflict'
      })
    }
    if (this.pending.size >= MAX_PENDING) {
      return Promise.resolve({
        type: 'failed',
        errorCode: 'browser_client_page_renderer_request_capacity'
      })
    }
    return new Promise<RendererOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(request.requestId)
        if (pending) {
          this.fail(pending, 'browser_client_page_renderer_subscriber_timeout')
        }
      }, REQUEST_TIMEOUT_MS)
      const pending: PendingRequest = { request, subscriberGeneration: null, timer, resolve }
      this.pending.set(request.requestId, pending)
      const callback = this.callback
      if (!callback) {
        this.queuedRequestIds.push(request.requestId)
        return
      }
      this.dispatch(request.requestId, this.subscriberGeneration, callback)
    })
  }

  resetForTest(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
    }
    this.pending.clear()
    this.queuedRequestIds.length = 0
    this.callback = null
  }

  private dispatch(
    requestId: string,
    generation: number,
    callback: TauriRendererRequestCallback
  ): void {
    const pending = this.pending.get(requestId)
    if (!pending || pending.subscriberGeneration !== null) {
      return
    }
    pending.subscriberGeneration = generation
    void Promise.resolve()
      .then(() => callback(pending.request))
      .then(
        (outcome) => this.onOutcome(pending, generation, outcome),
        () => this.fail(pending, 'browser_client_page_renderer_handler_failed')
      )
  }

  private onOutcome(pending: PendingRequest, generation: number, candidate: unknown): void {
    if (
      this.pending.get(pending.request.requestId) !== pending ||
      pending.subscriberGeneration !== generation
    ) {
      return
    }
    const outcome = BrowserClientPageRendererOutcome.safeParse(candidate)
    if (!outcome.success || !outcomeMatchesRequest(outcome.data, pending.request)) {
      this.fail(pending, 'browser_client_page_renderer_result_invalid')
      return
    }
    this.settle(pending)
    pending.resolve(outcome.data)
  }

  private failSubscriberRequests(generation: number, errorCode: string): void {
    for (const pending of this.pending.values()) {
      if (pending.subscriberGeneration === generation) {
        this.fail(pending, errorCode)
      }
    }
  }

  private fail(pending: PendingRequest, errorCode: string): void {
    const outcome: RendererOutcome = { type: 'failed', errorCode }
    if (this.pending.get(pending.request.requestId) !== pending) {
      return
    }
    this.settle(pending)
    pending.resolve(outcome)
  }

  private settle(pending: PendingRequest): void {
    if (this.pending.get(pending.request.requestId) !== pending) {
      return
    }
    this.pending.delete(pending.request.requestId)
    clearTimeout(pending.timer)
    if (pending.subscriberGeneration === null) {
      const queuedIndex = this.queuedRequestIds.indexOf(pending.request.requestId)
      if (queuedIndex !== -1) {
        this.queuedRequestIds.splice(queuedIndex, 1)
      }
    }
  }
}

export const tauriBrowserClientPageRendererBus = new TauriBrowserClientPageRendererBus()
