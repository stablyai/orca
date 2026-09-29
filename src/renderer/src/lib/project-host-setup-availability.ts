import {
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import { isHostLocalProjectId } from '../../../shared/project-host-setup-projection'
import { isEphemeralVmRuntimeEnvironment } from '../../../shared/runtime-environments'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { ProjectHostSetup } from '../../../shared/project-types'

// Availability/connect guidance for needs-setup run-target rows — extracted so
// project-host-setup-options.ts stays under the file line ratchet.

export function isEphemeralVmProjectHost(host: ExecutionHostRegistryEntry | undefined): boolean {
  return host?.kind === 'runtime' && isEphemeralVmRuntimeEnvironment(host)
}

// Why: a per-workspace-env SSH repo projects a setup with hostId `ssh:runtime-ssh-<id>`. The
// execution-host registry filters runtime-owned targets, so its host is absent here — guard on the
// hostId directly so the hidden target never becomes a selectable run-target option.
export function isRuntimeOwnedSshSetupHost(hostId: ExecutionHostId): boolean {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'ssh' && isRuntimeOwnedSshTargetId(parsed.targetId)
}

export function getHostSetupAvailability(host: ExecutionHostRegistryEntry): {
  isAvailable: boolean
  detail: string
} {
  if (host.health === 'blocked') {
    return {
      isAvailable: false,
      detail: 'Orca server version is incompatible'
    }
  }
  // Why: disconnected hosts cannot confirm project setup or runtime capabilities,
  // so connection state needs to win over setup guidance.
  const healthUnavailableDetail = getHostHealthUnavailableDetail(host.health)
  if (healthUnavailableDetail) {
    return {
      isAvailable: false,
      detail: healthUnavailableDetail
    }
  }
  if (host.kind === 'runtime') {
    if (!host.capabilities) {
      return {
        isAvailable: false,
        detail: 'Checking host capabilities'
      }
    }
    if (
      !host.capabilities.includes(PROJECT_HOST_SETUP_RUNTIME_CAPABILITY) ||
      !host.capabilities.includes(WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY)
    ) {
      return {
        isAvailable: false,
        detail: 'Update Orca on this host to set up projects'
      }
    }
  }
  return {
    isAvailable: true,
    detail: ''
  }
}

function getHostHealthUnavailableDetail(
  health: ExecutionHostRegistryEntry['health']
): string | null {
  switch (health) {
    case 'connecting':
      return 'Connecting to host'
    case 'disconnected':
      return 'Connect this host to set up projects'
    case 'error':
      return 'Host connection needs attention'
    case 'available':
    case 'blocked':
    case 'local':
      return null
  }
}

export function canSetProjectLocation(
  projectId: string,
  isAvailable: boolean,
  pendingSetup: ProjectHostSetup | undefined
): boolean {
  // Why: setting up on another host links by project identity, and a host-local
  // `repo:<id>` project has none to match against — the call always fails, so offer
  // the plain status line rather than a button that only ever toasts an error.
  if (!isAvailable || isHostLocalProjectId(projectId)) {
    return false
  }
  if (!pendingSetup) {
    return true
  }
  return pendingSetup.setupState === 'not-set-up' || pendingSetup.setupState === 'error'
}

type HostConnectAction =
  | { kind: 'ssh'; targetId: string }
  | { kind: 'runtime'; environmentId: string }

export function getHostConnectAction(
  host: ExecutionHostRegistryEntry
): HostConnectAction | undefined {
  if (host.health !== 'disconnected' && host.health !== 'error') {
    return undefined
  }
  const parsed = parseExecutionHostId(host.id)
  if (parsed?.kind === 'ssh') {
    return { kind: 'ssh', targetId: parsed.targetId }
  }
  if (parsed?.kind === 'runtime') {
    return { kind: 'runtime', environmentId: parsed.environmentId }
  }
  return undefined
}

export function getPendingSetupDetail(setup: ProjectHostSetup): string {
  switch (setup.setupState) {
    case 'not-set-up':
      return 'Project tracked on this host but not set up'
    case 'setting-up':
      return 'Project setup is in progress'
    case 'error':
      return 'Project setup needs attention'
    case 'unsupported':
      return 'Project is unsupported on this host'
    case 'ready':
      return setup.path
  }
}
