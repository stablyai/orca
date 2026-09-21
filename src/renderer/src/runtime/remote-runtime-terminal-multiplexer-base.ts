import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isRecoverableRemoteRuntimeConnectionError } from '../../../shared/remote-runtime-client-error-classification'
import {
  encodeTerminalStreamFrame,
  type TerminalStreamOpcode
} from '../../../shared/terminal-stream-protocol'
import {
  recordE2eRemoteStreamFrame,
  recordE2eRemoteTransportSubscribe,
  unsubscribeRuntimeEnvironmentForE2e
} from './remote-runtime-terminal-e2e-control'
import {
  clearResyncTimer,
  clearSnapshot,
  discardOutputAcknowledgements,
  rejectPendingSnapshotRequest
} from './remote-runtime-terminal-snapshot-state'
import type {
  RemoteRuntimeMultiplexedTerminalState,
  RuntimeEnvironmentSubscriptionHandle
} from './remote-runtime-terminal-multiplexer-types'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'

export abstract class RemoteRuntimeTerminalMultiplexerBase {
  protected readonly streams = new Map<number, RemoteRuntimeMultiplexedTerminalState>()
  protected subscription: RuntimeEnvironmentSubscriptionHandle | null = null
  protected connectPromise: Promise<void> | null = null
  protected readyResolver: (() => void) | null = null
  protected readyRejecter: ((error: Error) => void) | null = null
  protected ready = false
  protected nextStreamId = 1
  protected nextSnapshotRequestId = 1

  constructor(
    protected readonly environmentId: string,
    protected readonly environmentRevision: number | undefined,
    private readonly releaseIfCurrent: (
      environmentId: string,
      multiplexer: RemoteRuntimeTerminalMultiplexerBase
    ) => void
  ) {}

  protected abstract handleResponse(response: RuntimeRpcResponse<unknown>): void
  protected abstract handleBinary(bytes: Uint8Array<ArrayBufferLike>): void

  matchesCurrentEnvironmentRevision(): boolean {
    return getRuntimeEnvironmentRevision(this.environmentId) === this.environmentRevision
  }

  closeForEnvironmentReplacement(): void {
    this.handleClose('Runtime environment pairing changed.')
  }

  protected allocateStreamId(): number {
    const start = this.nextStreamId
    do {
      const candidate = this.nextStreamId
      this.nextStreamId = this.nextStreamId >= 0x7fffffff ? 1 : this.nextStreamId + 1
      if (!this.streams.has(candidate)) {
        return candidate
      }
    } while (this.nextStreamId !== start)
    throw new Error('No remote terminal stream ids available.')
  }

  protected allocateSnapshotRequestId(): number {
    const id = this.nextSnapshotRequestId
    this.nextSnapshotRequestId =
      this.nextSnapshotRequestId >= 0x7fffffff ? 1 : this.nextSnapshotRequestId + 1
    return id
  }

  protected ensureConnected(): Promise<void> {
    if (this.ready && this.subscription) {
      return Promise.resolve()
    }
    if (this.connectPromise) {
      return this.connectPromise
    }
    const connectPromise = new Promise<void>((resolve, reject) => {
      this.readyResolver = resolve
      this.readyRejecter = reject
      recordE2eRemoteTransportSubscribe()
      void window.api.runtimeEnvironments
        .subscribe(
          {
            selector: this.environmentId,
            method: 'terminal.multiplex',
            params: {},
            timeoutMs: 15_000,
            expectedEnvironmentPairingRevision: this.environmentRevision
          },
          {
            onResponse: (response) => this.handleResponse(response),
            onBinary: (bytes) => this.handleBinary(bytes),
            onError: (error) => {
              if (isRecoverableRemoteRuntimeConnectionError(error)) {
                this.handleClose(error.message)
              } else {
                this.failConnection(Object.assign(new Error(error.message), { code: error.code }))
              }
            },
            onClose: () => this.handleClose('Remote Orca runtime closed the connection.')
          }
        )
        .then((subscription) => {
          if (this.connectPromise !== connectPromise || (!this.ready && !this.readyRejecter)) {
            // Why: close/error can arrive before subscribe() resolves because
            // preload listens before ipcMain.handle() returns. The multiplexer
            // may already be released; do not retain the late handle.
            unsubscribeRuntimeEnvironmentForE2e(subscription)
            return
          }
          this.subscription = subscription
          this.resolveReadyIfConnected()
        })
        .catch((error) => {
          if (this.connectPromise === connectPromise) {
            this.connectPromise = null
            this.readyResolver = null
            this.readyRejecter = null
          }
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
    this.connectPromise = connectPromise
    return this.connectPromise
  }

  protected sendFrame(
    streamId: number,
    opcode: TerminalStreamOpcode,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array()
  ): boolean {
    if (!this.matchesCurrentEnvironmentRevision() || !this.ready || !this.subscription) {
      return false
    }
    try {
      this.subscription.sendBinary(encodeTerminalStreamFrame({ opcode, streamId, seq: 0, payload }))
      recordE2eRemoteStreamFrame(opcode)
      return true
    } catch (error) {
      this.handleClose(
        error instanceof Error ? error.message : 'Remote terminal transport write failed.'
      )
      return false
    }
  }

  protected resolveReadyIfConnected(): void {
    if (!this.ready || !this.subscription) {
      return
    }
    this.readyResolver?.()
    this.readyResolver = null
    this.readyRejecter = null
  }

  protected failConnection(error: Error): void {
    this.readyRejecter?.(error)
    this.readyResolver = null
    this.readyRejecter = null
    for (const stream of this.streams.values()) {
      // Why: a stream still awaiting ensureConnected receives this failure through its rejected promise.
      if (stream.subscriptionRequested) {
        stream.callbacks.onError?.(error.message)
      }
    }
    this.handleClose(undefined, false)
  }

  protected handleClose(message?: string, recoverable = true): void {
    const streams = Array.from(this.streams.values())
    const closingSubscription = this.subscription
    this.ready = false
    this.connectPromise = null
    this.readyRejecter?.(new Error(message ?? 'Remote runtime connection closed.'))
    this.readyResolver = null
    this.readyRejecter = null
    this.subscription = null
    if (closingSubscription) {
      unsubscribeRuntimeEnvironmentForE2e(closingSubscription)
    }
    this.streams.clear()
    // Why: close callbacks may resubscribe synchronously; release first so every replacement shares the new environment multiplexer.
    this.releaseIfCurrent(this.environmentId, this)
    for (const stream of streams) {
      discardOutputAcknowledgements(stream)
      stream.watchdog.dispose()
      clearSnapshot(stream)
      clearResyncTimer(stream)
      rejectPendingSnapshotRequest(stream, message ?? 'Remote runtime connection closed.')
      const canHandleClose = Boolean(stream.callbacks.onTransportClose)
      stream.callbacks.onTransportClose?.({ recoverable })
      if (message && !canHandleClose) {
        stream.callbacks.onError?.(message)
      }
    }
  }

  protected closeIfIdle(): void {
    if (this.streams.size > 0) {
      return
    }
    if (this.subscription) {
      unsubscribeRuntimeEnvironmentForE2e(this.subscription)
    }
    this.subscription = null
    this.connectPromise = null
    this.ready = false
    this.releaseIfCurrent(this.environmentId, this)
  }
}
