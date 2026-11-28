export type RemoteRuntimePairingStage = 'connect' | 'host-identity' | 'access-grant' | 'runtime'

/** Separate error type from ws/tweetnacl imports: mobile’s transitive type graph has no Node-only dependencies installed. */
export class RemoteRuntimeClientError extends Error {
  readonly code: string
  /** Structured recovery data must survive the WebSocket adapter unchanged. */
  readonly data?: unknown
  readonly pairingStage?: RemoteRuntimePairingStage
  readonly closeCode?: number
  /** This Orca's own proof that the keyed request never left it. A field, not `data`: data can come
   *  from a server's answer, and a server must not be able to claim this for us. */
  readonly requestUnsent?: boolean

  constructor(
    code: string,
    message: string,
    details?: {
      data?: unknown
      pairingStage?: RemoteRuntimePairingStage
      closeCode?: number
      requestUnsent?: boolean
    }
  ) {
    super(message)
    this.name = 'RemoteRuntimeClientError'
    this.code = code
    this.data = details?.data
    this.pairingStage = details?.pairingStage
    this.closeCode = details?.closeCode
    this.requestUnsent = details?.requestUnsent
  }
}
