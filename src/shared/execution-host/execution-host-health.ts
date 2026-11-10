import type { SshConnectionStatus } from '../ssh-types'
import type { RuntimeHostBlockedReason } from '../remote-runtime/host-status/runtime-host-status'
import type { EphemeralVmRuntimeStatus } from '../ephemeral-vm-runtimes'

export type ExecutionHostHealth =
  | 'local'
  | 'available'
  | 'connecting'
  | 'blocked'
  | 'disconnected'
  | 'error'
  // VM-backed hosts: the VM lifecycle explains why the server is unreachable.
  | 'provisioning'
  | 'suspended'
  | 'waking'

/** The VM lifecycle facts that change how a VM-backed host reads; null defers to transport health. */
export type ExecutionHostVmState =
  | 'provisioning'
  | 'suspended'
  | 'waking'
  | 'resume_failed'
  // Create failed or was interrupted (app quit mid-provision); the VM may still need Destroy.
  | 'provision_failed'

/** One VM runtime record projected onto the host it serves. */
export type EphemeralVmHostLifecycle = {
  runtimeEnvironmentId: string
  status: EphemeralVmRuntimeStatus
  /** A resume is in flight for this VM (the record only flips once it finishes). */
  waking: boolean
}

/** An SSH host's health; a target with no lifecycle state has never connected. */
export function getSshConnectionHealth(
  status: SshConnectionStatus | undefined
): ExecutionHostHealth {
  switch (status) {
    case 'connected':
      return 'available'
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return 'connecting'
    case 'auth-failed':
    case 'error':
    case 'reconnection-failed':
      return 'error'
    case 'disconnected':
    case undefined:
      return 'disconnected'
  }
}

/** A VM record's lifecycle state; running/cleanup states leave health to the server transport. */
export function getEphemeralVmHostState(
  status: EphemeralVmRuntimeStatus,
  waking: boolean
): ExecutionHostVmState | null {
  switch (status) {
    case 'provisioning':
      return 'provisioning'
    case 'suspended':
      return waking ? 'waking' : 'suspended'
    case 'resume_failed':
      return waking ? 'waking' : 'resume_failed'
    // A failed suspend leaves the VM running; only an explicit retry wakes it.
    case 'suspend_failed':
      return waking ? 'waking' : null
    // Provision outcomes outrank a stray wake: neither has a VM to resume.
    case 'failed':
      return 'provision_failed'
    case 'running':
    case 'cleanup_pending':
    case 'cleanup_failed':
    case 'cleaned':
      return null
  }
}

export function getExecutionHostVmStateHealth(state: ExecutionHostVmState): ExecutionHostHealth {
  switch (state) {
    case 'provisioning':
    case 'suspended':
    case 'waking':
      return state
    case 'resume_failed':
    case 'provision_failed':
      return 'error'
  }
}

export function getExecutionHostHealthLabel(
  health: ExecutionHostHealth,
  blockedReason?: RuntimeHostBlockedReason,
  vmState?: ExecutionHostVmState
): string {
  switch (health) {
    case 'local':
      return 'Local'
    case 'available':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'blocked':
      return blockedReason === 'access-revoked'
        ? 'Re-pair needed'
        : blockedReason === 'server-replaced'
          ? 'Different server'
          : 'Update needed'
    case 'disconnected':
      return 'Disconnected'
    case 'error':
      return vmState === 'resume_failed'
        ? 'Resume failed'
        : vmState === 'provision_failed'
          ? 'Setup failed'
          : 'Needs attention'
    case 'provisioning':
      return 'Provisioning'
    case 'suspended':
      return 'Suspended'
    case 'waking':
      return 'Waking'
  }
}
