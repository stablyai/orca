import type WebSocket from 'ws'
import type { PairedE2EEClientHandshake } from '../../paired-e2ee-client-handshake'
import type { RemoteRuntimeHandshakeState } from '../../remote-runtime-client-handshake'
import { RemoteRuntimeClientError } from '../../remote-runtime-client-error'
import { RuntimeRpcEnvelopeSchema, type RuntimeRpcResponse } from '../../runtime-rpc-envelope'
import { parseRemoteRuntimeJsonText } from './remote-runtime-request-frames'

type SubscriptionFrameRouterOptions<TResult> = {
  handshake: PairedE2EEClientHandshake
  sealAuth: () => Promise<string>
  isSettled: () => boolean
  serializedRequest: string
  requestId: string
  send: (frame: string) => void
  fail: (error: RemoteRuntimeClientError) => void
  onAuthenticated: () => void
  // Responses to requests the caller sent over this same socket; unmatched ids stay a hard failure.
  resolvePendingRequest?: (response: RuntimeRpcResponse<unknown>) => boolean
  callbacks: {
    onResponse: (response: RuntimeRpcResponse<TResult>) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  }
}

export class RemoteRuntimeSubscriptionFrameRouter<TResult> {
  state: RemoteRuntimeHandshakeState = 'awaiting_ready'

  constructor(private readonly options: SubscriptionFrameRouterOptions<TResult>) {}

  handleFrame(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      this.handleBinaryFrame(new Uint8Array(data as Buffer))
      return
    }
    const frame = data.toString()
    if (this.state === 'awaiting_ready') {
      this.handleReadyFrame(frame)
      return
    }
    const plaintext = this.options.handshake.channel.openText(frame)
    if (plaintext === null) {
      this.options.fail(
        new RemoteRuntimeClientError(
          'invalid_runtime_response',
          'Remote Orca runtime returned an undecryptable frame.'
        )
      )
      return
    }
    if (this.state === 'awaiting_authenticated') {
      this.handleAuthenticatedFrame(plaintext)
      return
    }
    this.handleRpcFrame(plaintext)
  }

  private handleReadyFrame(frame: string): void {
    const readyFrame = this.options.handshake.acceptReadyText(frame)
    if (readyFrame !== 'accepted') {
      this.options.fail(
        new RemoteRuntimeClientError(
          'invalid_runtime_response',
          readyFrame === 'invalid'
            ? 'Remote Orca runtime returned an invalid E2EE handshake frame.'
            : 'Remote Orca runtime returned an unexpected E2EE handshake frame.'
        )
      )
      return
    }
    this.state = 'awaiting_authenticated'
    void this.sendAuth()
  }

  private async sendAuth(): Promise<void> {
    let frame: string
    try {
      frame = await this.options.sealAuth()
    } catch (error) {
      this.options.fail(
        error instanceof RemoteRuntimeClientError
          ? error
          : new RemoteRuntimeClientError('invalid_argument', String(error))
      )
      return
    }
    if (!this.options.isSettled() && this.state === 'awaiting_authenticated') {
      this.options.send(frame)
    }
  }

  private handleAuthenticatedFrame(plaintext: string): void {
    const authenticated = this.options.handshake.classifyAuthReply(plaintext)
    if (authenticated.kind === 'invalid') {
      this.options.fail(
        new RemoteRuntimeClientError(
          'invalid_runtime_response',
          'Remote Orca runtime returned an invalid E2EE auth frame.'
        )
      )
      return
    }
    if (authenticated.kind !== 'authenticated') {
      const code =
        authenticated.errorCode === 'unauthorized' ? 'unauthorized' : 'invalid_runtime_response'
      this.options.fail(
        new RemoteRuntimeClientError(code, 'Remote Orca runtime rejected the pairing token.')
      )
      return
    }
    this.state = 'ready'
    this.options.send(this.options.handshake.channel.sealText(this.options.serializedRequest))
    this.options.onAuthenticated()
  }

  private handleRpcFrame(plaintext: string): void {
    let raw: unknown
    try {
      raw = parseRemoteRuntimeJsonText(plaintext)
    } catch {
      this.options.fail(
        new RemoteRuntimeClientError(
          'invalid_runtime_response',
          'Remote Orca runtime returned an invalid response frame.'
        )
      )
      return
    }
    const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
    if (!parsed.success || '_keepalive' in parsed.data) {
      return
    }
    const response = parsed.data as RuntimeRpcResponse<TResult>
    if (response.id === this.options.requestId) {
      this.deliver(() => this.options.callbacks.onResponse(response))
      return
    }
    if (this.options.resolvePendingRequest?.(response as RuntimeRpcResponse<unknown>)) {
      return
    }
    this.options.fail(
      new RemoteRuntimeClientError(
        'invalid_runtime_response',
        'Remote Orca runtime returned a mismatched response id.'
      )
    )
  }

  private handleBinaryFrame(frame: Uint8Array<ArrayBufferLike>): void {
    if (this.state !== 'ready') {
      this.options.fail(
        new RemoteRuntimeClientError(
          'invalid_runtime_response',
          'Remote Orca runtime returned binary data before authentication.'
        )
      )
      return
    }
    const plaintext = this.options.handshake.channel.openBinary(frame)
    if (plaintext === null) {
      this.options.fail(
        new RemoteRuntimeClientError(
          'invalid_runtime_response',
          'Remote Orca runtime returned an undecryptable binary frame.'
        )
      )
      return
    }
    this.deliver(() => this.options.callbacks.onBinary?.(plaintext))
  }

  // ws invokes this directly; route consumer throws to finishError instead of crashing the process.
  private deliver(emit: () => void): void {
    try {
      emit()
    } catch (error) {
      this.options.fail(
        error instanceof RemoteRuntimeClientError
          ? error
          : new RemoteRuntimeClientError(
              'runtime_error',
              error instanceof Error ? error.message : String(error)
            )
      )
    }
  }
}
