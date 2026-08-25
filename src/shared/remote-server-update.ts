import type { UpdateStatus } from './update-status-types'

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
  // Why: monotonic counter bumped on every status change; callers pass it back to
  // updater.wait to long-poll for the next change instead of high-frequency polling.
  revision: number
}

/** A snapshot plus whether the wait ended on the bounded timeout rather than a change. */
export type RemoteServerUpdaterWaitResult = RemoteServerUpdaterSnapshot & {
  timedOut: boolean
}

export type RemoteServerUpdateInstallResult = {
  accepted: true
  fromVersion: string
  targetVersion: string
  runtimeId: string
}
