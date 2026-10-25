import type {
  FrameDecoder,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  PreparedJsonRpcPayload
} from './protocol'
import type { DispatcherClientWriter, SinkWriteSettlement } from './dispatcher-client-writer'

export type RequestContext = {
  clientId: number
  isStale: () => boolean
  signal?: AbortSignal
  sessionIdentity?: RelayClientSessionIdentity
  onResponseSettled?: (handler: (result: SinkWriteSettlement) => void) => void
}

export type RelayClientSessionIdentity = {
  principal: string
  authenticated: boolean
  allowSessionOwner: boolean
  authenticationKind: 'unproved' | 'launch-nonce' | 'endpoint-credential'
}

export type RelayClientSourceOptions = {
  pauseReads?: () => void
  resumeReads?: () => void
}

export type PtyDataPublicationAdmission = (
  clientId: number,
  params: Readonly<Record<string, unknown>>
) => boolean

export type MethodHandler = (
  params: Record<string, unknown>,
  context: RequestContext
) => Promise<unknown>

export type NotificationHandler = (params: Record<string, unknown>, context: RequestContext) => void

export type DroppedProducerNotificationLog = {
  generation: number
  loggedKeys: Set<string>
}

export type RelayClient = {
  id: number
  decoder: FrameDecoder
  writer: DispatcherClientWriter
  bulkChain: Promise<void>
  nextOutgoingSeq: number
  highestReceivedSeq: number
  // Attach time bounds never-speaking clients that have no lastReceivedAt for silence checks.
  attachedAt: number
  // Reap half-open clients so abandoned viewers cannot retain owner leases and paused PTYs forever.
  lastReceivedAt: number | null
  // Apply silence windows only after observed keepalives; remote CLI requests may wait minutes without inbound traffic.
  keepaliveObserved: boolean
  generation: number
  closed: boolean
  droppedNotificationLog: DroppedProducerNotificationLog | null
  sessionIdentity: RelayClientSessionIdentity
}

export type OutgoingJsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export type PreparedRelayFrame = Readonly<{
  payload: PreparedJsonRpcPayload
  frameBytes: number
  ptyDataAdmissionParams: Readonly<Record<string, unknown>> | null
}>

export type PendingRelayRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Cap method diagnostics within each generation because synthetic method names can grow without bound.
export const DROPPED_NOTIFICATION_LOG_KEY_LIMIT = 64

export const RESPONSE_OVER_CAPACITY_MESSAGE =
  'Relay response exceeded the bounded transport capacity'

export const RELAY_TO_CLIENT_REQUEST_TIMEOUT_MS = 30_000
