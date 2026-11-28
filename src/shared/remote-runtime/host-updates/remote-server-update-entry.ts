import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot,
  RemoteServerUpdateSupport
} from '../host-catalog/remote-server-update'
import type { RuntimeStatus } from '../session-graph/runtime-session-contracts'
import type { UpdateCheckOptions } from '../../updater/update-status-types'

export type RemoteServerUpdatePhase =
  | 'checking'
  | 'available'
  | 'current'
  | 'manual'
  | 'offline'
  | 'queued'
  | 'checking-update'
  | 'downloading'
  /** Ready to restart; only the staged API stops here, the full run goes straight on. */
  | 'downloaded'
  | 'restarting'
  | 'updated'
  | 'failed'

export type RemoteServerUpdateEntry = {
  environmentId: string
  name: string
  phase: RemoteServerUpdatePhase
  currentVersion: string | null
  targetVersion: string | null
  progress: number | null
  runtimeId: string | null
  liveTabCount: number
  liveLeafCount: number
  support: RemoteServerUpdateSupport | null
  error: string | null
  /** This desktop updates it over SSH, not through the host's own updater. */
  managedOverSsh?: boolean
  /** This app's version when it was compared; read through getRemoteServerNewerThanClientVersion. */
  clientVersion?: string | null
  /** The restart the host accepted, so a client can wait for it again. */
  install?: RemoteServerUpdateInstallResult
}

export type RemoteServerUpdateTransport = {
  getRuntimeStatus: (
    environmentId: string,
    timeoutMs?: number,
    options?: { force?: true }
  ) => Promise<RuntimeStatus>
  getUpdaterStatus: (
    environmentId: string,
    timeoutMs?: number
  ) => Promise<RemoteServerUpdaterSnapshot>
  check: (
    environmentId: string,
    options: UpdateCheckOptions
  ) => Promise<RemoteServerUpdaterSnapshot>
  download: (environmentId: string) => Promise<RemoteServerUpdaterSnapshot>
  install: (environmentId: string) => Promise<RemoteServerUpdateInstallResult>
  wait: (milliseconds: number) => Promise<void>
  now?: () => number
  /** Words a failure for this client's UI; defaults to the raw error message. */
  describeError?: (error: unknown) => string
}

/** A failure in the client's words, else the raw error message. */
export const describeRemoteServerUpdateError = (
  transport: Pick<RemoteServerUpdateTransport, 'describeError'>,
  error: unknown
): string =>
  transport.describeError?.(error) ?? (error instanceof Error ? error.message : String(error))

export type RemoteServerUpdateTiming = {
  operationTimeoutMs: number
  reconnectTimeoutMs: number
  pollIntervalMs: number
}

export const DEFAULT_REMOTE_SERVER_UPDATE_TIMING: RemoteServerUpdateTiming = {
  operationTimeoutMs: 10 * 60 * 1000,
  reconnectTimeoutMs: 3 * 60 * 1000,
  pollIntervalMs: 500
}

export type RemoteServerUpdateRunOptions = {
  checkOptions?: UpdateCheckOptions
  timing?: RemoteServerUpdateTiming
}
