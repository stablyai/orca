export type RemoteRuntimePairingStage = 'connect' | 'host-identity' | 'access-grant' | 'runtime'

/**
 * Error type for the remote-runtime client, split out from
 * `remote-runtime-client.ts` so type-only consumers can reference it without
 * pulling in that module's `ws`/`tweetnacl` value imports. Mobile reaches this
 * type transitively (runtime-types → shared-control-types) and its typecheck
 * has no Node-only deps installed.
 */
export class RemoteRuntimeClientError extends Error {
  readonly code: string
  /** Structured recovery data must survive the WebSocket adapter unchanged. */
  readonly data?: unknown
  readonly pairingStage?: RemoteRuntimePairingStage
  readonly closeCode?: number

  constructor(
    code: string,
    message: string,
    details?: {
      data?: unknown
      pairingStage?: RemoteRuntimePairingStage
      closeCode?: number
    }
  ) {
    super(message)
    this.name = 'RemoteRuntimeClientError'
    this.code = code
    this.data = details?.data
    this.pairingStage = details?.pairingStage
    this.closeCode = details?.closeCode
  }
}
