import { decrypt, encrypt } from './e2ee-crypto'
import {
  classifyRemoteRuntimeReadyFrame,
  parseRemoteRuntimeAuthenticatedFrame,
  type RemoteRuntimeHandshakeState
} from './remote-runtime-client-handshake'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import {
  isKeepaliveFrame,
  RuntimeRpcEnvelopeSchema,
  type RuntimeRpcResponse
} from './runtime-rpc-envelope'
import { parseRemoteRuntimeJsonText } from './remote-runtime-request-frames'
import type { RuntimeStatus } from './runtime-types'

type RequestResponseRouterOptions<TResult> = {
  sharedKey: Uint8Array
  serializedAuth: string
  serializedStatusRequest: string | null
  requestId: string
  statusRequestId: string | null
  validateStatus?: (response: RuntimeRpcResponse<RuntimeStatus>) => void
  send: (frame: string) => void
  sendRequestedRpc: () => void
  refreshTimeout: () => void
  finishError: (error: Error) => void
  finishResponse: (response: RuntimeRpcResponse<TResult>) => void
}

export class RemoteRuntimeRequestResponseRouter<TResult> {
  state: RemoteRuntimeHandshakeState = 'awaiting_ready'
  private awaitingRequestId: string
  private awaitingStatus: boolean

  constructor(private readonly options: RequestResponseRouterOptions<TResult>) {
    this.awaitingRequestId = options.statusRequestId ?? options.requestId
    this.awaitingStatus = options.statusRequestId !== null
  }

  get pairingStage(): 'connect' | 'host-identity' | 'runtime' {
    return this.state === 'awaiting_ready'
      ? 'connect'
      : this.state === 'awaiting_authenticated'
        ? 'host-identity'
        : 'runtime'
  }

  handleTextFrame(frame: string): void {
    if (this.state === 'awaiting_ready') {
      this.handleReadyFrame(frame)
      return
    }
    const plaintext = decrypt(frame, this.options.sharedKey)
    if (plaintext === null) {
      this.options.finishError(
        new RemoteRuntimeClientError(
          'invalid_runtime_response',
          'Remote Orca runtime returned an undecryptable frame.',
          {
            pairingStage:
              this.state === 'awaiting_authenticated' ? 'host-identity' : this.pairingStage
          }
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
    const readyFrame = classifyRemoteRuntimeReadyFrame(frame)
    if (readyFrame !== 'ready') {
      this.options.finishError(
        new RemoteRuntimeClientError(
          'invalid_runtime_response',
          readyFrame === 'invalid'
            ? 'Remote Orca runtime returned an invalid E2EE handshake frame.'
            : 'Remote Orca runtime returned an unexpected E2EE handshake frame.',
          { pairingStage: 'host-identity' }
        )
      )
      return
    }
    this.state = 'awaiting_authenticated'
    this.options.send(encrypt(this.options.serializedAuth, this.options.sharedKey))
  }

  private handleAuthenticatedFrame(plaintext: string): void {
    const authenticated = parseRemoteRuntimeAuthenticatedFrame(plaintext)
    if (authenticated.kind === 'invalid') {
      this.options.finishError(
        new RemoteRuntimeClientError(
          'invalid_runtime_response',
          'Remote Orca runtime returned an invalid E2EE auth frame.',
          { pairingStage: 'host-identity' }
        )
      )
      return
    }
    if (authenticated.kind !== 'authenticated') {
      const code = authenticated.unauthorized ? 'unauthorized' : 'invalid_runtime_response'
      this.options.finishError(
        new RemoteRuntimeClientError(code, 'Remote Orca runtime rejected the pairing token.', {
          pairingStage: code === 'unauthorized' ? 'access-grant' : 'host-identity'
        })
      )
      return
    }
    this.state = 'ready'
    if (this.options.serializedStatusRequest) {
      this.options.send(encrypt(this.options.serializedStatusRequest, this.options.sharedKey))
      return
    }
    this.options.sendRequestedRpc()
  }

  private handleRpcFrame(plaintext: string): void {
    let raw: unknown
    try {
      raw = parseRemoteRuntimeJsonText(plaintext)
    } catch {
      this.invalidResponse('Remote Orca runtime returned an invalid response frame.')
      return
    }
    if (isKeepaliveFrame(raw)) {
      this.options.refreshTimeout()
      return
    }
    const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
    if (!parsed.success || '_keepalive' in parsed.data) {
      this.invalidResponse('Remote Orca runtime returned an invalid response frame.')
      return
    }
    if (parsed.data.id !== this.awaitingRequestId) {
      this.invalidResponse('Remote Orca runtime returned a mismatched response id.')
      return
    }
    if (this.awaitingStatus && this.options.validateStatus) {
      try {
        this.options.validateStatus(parsed.data as RuntimeRpcResponse<RuntimeStatus>)
      } catch (error) {
        this.options.finishError(
          error instanceof Error
            ? error
            : new RemoteRuntimeClientError('runtime_error', String(error))
        )
        return
      }
      this.awaitingStatus = false
      this.awaitingRequestId = this.options.requestId
      this.options.refreshTimeout()
      this.options.sendRequestedRpc()
      return
    }
    this.options.finishResponse(parsed.data as RuntimeRpcResponse<TResult>)
  }

  private invalidResponse(message: string): void {
    this.options.finishError(
      new RemoteRuntimeClientError('invalid_runtime_response', message, {
        pairingStage: 'runtime'
      })
    )
  }
}
