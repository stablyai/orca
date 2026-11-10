// The host answers managedRuntime.subscribe, managedRuntime.install and managedRuntime.cancel.
export const MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY = 'managed-runtime.install.v1' as const
// Why separate: a host that installs may predate managedRuntime.remove.
export const MANAGED_RUNTIME_REMOVE_RUNTIME_CAPABILITY = 'managed-runtime.remove.v1' as const

export type ManagedRuntimeOperation = {
  id: string
  kind: 'install' | 'remove'
  /** A Cancel ends in `cancelled`, or `succeeded` when the install had already committed. */
  phase:
    | 'downloading'
    | 'extracting'
    | 'verifying'
    | 'removing'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
  downloadedBytes: number
  totalBytes: number | null
  error?: string
}

export type ManagedRuntimeInstallState = {
  agent: string
  /** Rises with every change the host publishes, across operations. */
  revision: number
  /** The host has a pinned release; otherwise no Install is offered. */
  available: boolean
  version: string | null
  /** The pinned release's download size; absent without one. */
  downloadBytes?: number
  installedVersion: string | null
  /** False with an installed version: an update is available. */
  installedCurrent: boolean
  /** The pinned release's folder is there but not whole; Install repairs it. */
  damaged?: boolean
  /** Orca's copy is there to remove, whole or damaged; absent from a host without Remove. */
  canRemove?: boolean
  /** What a chat start runs now: Orca's release, a copy found outside it, or nothing. */
  source: 'managed' | 'external' | null
  /** The latest operation; an ended one stays readable until the next starts. */
  operation: ManagedRuntimeOperation | null
}
