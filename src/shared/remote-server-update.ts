import type { UpdateStatus } from './update-status-types'

export const REMOTE_SERVER_UPDATE_CAPABILITY = 'updater.remote-control.v1' as const

export type RemoteServerUpdateInstallMode =
  | 'interactive'
  | 'supervised-headless-serve'
  | 'unsupported-headless-serve'

/**
 * How a headless `orca serve` host receives new versions. Detected from the running install —
 * `unknown` is reported rather than guessed when nothing proves the method.
 */
export type ServeManualUpdateMethod =
  | 'deb'
  | 'rpm'
  | 'appimage'
  | 'extracted-appimage'
  /** A repackaged root install whose host has no package manager that could apply Orca's package. */
  | 'externally-managed'
  | 'unknown'

/**
 * Outcome of the host's own release check. `pending` means no check has completed yet,
 * `unavailable` means the last one could not reach a fully published release, and `disabled` means
 * the operator opted out — none of the three is evidence that the host is current.
 */
export type ServeManualUpdateCheckState =
  | 'pending'
  | 'current'
  | 'update-available'
  | 'unavailable'
  | 'disabled'

/**
 * The operator-facing update contract for a host that cannot update itself.
 *
 * Optional on the wire: absence means the host predates this contract or does not update
 * manually, never that it is up to date. Additive per Rule 1 of
 * docs/reference/remote-wire-compatibility.md.
 */
export type ServeManualUpdateReport = {
  method: ServeManualUpdateMethod
  check: ServeManualUpdateCheckState
  currentVersion: string
  /** Newest fully published release, or null when no check has proven one. */
  latestVersion: string | null
  releaseUrl: string | null
  /** Ordered operator steps. Orca prints these and never runs any of them. */
  steps: string[]
  documentationUrl: string
}

export type RemoteServerUpdateSupport = {
  installMode: RemoteServerUpdateInstallMode
  automatic: boolean
  reason:
    | 'available'
    | 'manual-service-update-required'
    | 'unpackaged-build'
    | 'updater-unavailable'
  /** Present only on a host that reports a manual update contract. */
  manualUpdate?: ServeManualUpdateReport
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
