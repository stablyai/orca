import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../../../shared/execution-host/execution-host-registry-entry'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ExecutionHostHealth } from '../../../../../shared/execution-host/execution-host-health'

/** Why a host cannot take a project setup right now, from its health; null when health allows it. */
export function getHostHealthUnavailableDetail(health: ExecutionHostHealth): string | null {
  switch (health) {
    case 'connecting':
      return 'Connecting to host'
    case 'disconnected':
      return 'Connect this host to set up projects'
    case 'error':
      return 'Host connection needs attention'
    case 'provisioning':
      return 'VM is still provisioning'
    case 'suspended':
      return 'Resume this VM to set up projects'
    case 'waking':
      return 'VM is waking'
    case 'available':
    case 'blocked':
    case 'local':
      return null
  }
}

export function getHostSetupUnavailableDetail(
  host: ExecutionHostRegistryEntry,
  t: Translate = translate
): string | null {
  if (host.health === 'blocked') {
    return t(
      'auto.components.settings.RepositoryPane.hostSetupBlockedVersion',
      'Orca server version is incompatible'
    )
  }
  if (host.kind !== 'runtime') {
    return null
  }
  if (!host.capabilities) {
    return t(
      'auto.components.settings.RepositoryPane.hostSetupCheckingCapability',
      'Checking host capabilities'
    )
  }
  if (
    !host.capabilities.includes(PROJECT_HOST_SETUP_RUNTIME_CAPABILITY) ||
    !host.capabilities.includes(WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY)
  ) {
    return t(
      'auto.components.settings.RepositoryPane.hostSetupMissingCapability',
      'Update Orca on this host to set up projects'
    )
  }
  return null
}

export function getHostConnectAction(
  host: ExecutionHostRegistryEntry
): { kind: 'ssh'; targetId: string } | { kind: 'runtime'; environmentId: string } | undefined {
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
