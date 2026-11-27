import type { UpdateStatus } from '../../updater/update-status-types'
import type { RuntimeTerminalSummaryWithoutPreview } from '../../terminal/runtime/runtime-terminal-contracts'

export const REMOTE_SERVER_UPDATE_CAPABILITY = 'updater.remote-control.v1' as const

export type RemoteServerUpdateInstallMode =
  | 'interactive'
  | 'supervised-headless-serve'
  | 'unsupported-headless-serve'

export type RemoteServerUpdateSupport = {
  installMode: RemoteServerUpdateInstallMode
  automatic: boolean
  reason:
    | 'available'
    | 'manual-service-update-required'
    | 'unpackaged-build'
    | 'updater-unavailable'
}

export type RemoteServerUpdaterSnapshot = {
  appVersion: string
  runtimeId: string
  support: RemoteServerUpdateSupport
  status: UpdateStatus
}

export type RemoteServerUpdateInstallResult = {
  accepted: true
  fromVersion: string
  targetVersion: string
  runtimeId: string
}

/** What restarting this host for an update would stop; its other agents and terminals keep running. */
export type RemoteServerUpdateRestartImpact = {
  /** Chats whose agent runs inside the app (always on Windows); each offers a resume afterwards. */
  chats: RemoteServerUpdateStoppedChat[]
  /** Terminals the terminal daemon doesn't hold; their shells and anything in them end. */
  terminals: RuntimeTerminalSummaryWithoutPreview[]
}

export type RemoteServerUpdateStoppedChat = {
  sessionId: string
  agent: string | null
  worktreeId: string | null
  /** The chat's own name; null until it has one. */
  title: string | null
}
