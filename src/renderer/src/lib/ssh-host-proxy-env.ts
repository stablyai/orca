import {
  getSshTargetIdForExecutionHost,
  parseExecutionHostId
} from '../../../shared/execution-host'
import {
  getManagedOrcadSshTargetId,
  type ManagedOrcadEnvironmentSummary
} from '../../../shared/managed-orcad-execution-host'
import { buildConfiguredProxyEnv, type NetworkProxySettings } from '../../../shared/network-proxy'
import { useAppStore } from '@/store'

/** The persisted proxy fields a target row carries; structural so `SshTarget` passes as-is. */
type SshHostProxyTarget = { id: string } & NetworkProxySettings

/** The SSH target a pane's execution host belongs to: the host itself, or the managed server on it. */
export function sshTargetIdForExecutionHost(
  executionHostId: string | null | undefined,
  environments: readonly ManagedOrcadEnvironmentSummary[] | undefined
): string | null {
  const direct = getSshTargetIdForExecutionHost(executionHostId)
  if (direct) {
    return direct
  }
  const parsed = parseExecutionHostId(executionHostId)
  if (parsed?.kind !== 'runtime') {
    return null
  }
  const environment = (environments ?? []).find((entry) => entry.id === parsed.environmentId)
  return environment ? getManagedOrcadSshTargetId(environment) : null
}

/** The same, read from this client's store: how a caller allowed to read it — the pane layer, a
 *  background launch — hands the transport the fact a transport must not look up itself. */
export function sshTargetIdForExecutionHostFromStore(
  executionHostId: string | null | undefined
): string | null {
  return sshTargetIdForExecutionHost(executionHostId, runtimeEnvironmentsFromStore())
}

/** A paired client or an early boot may have no catalog yet; that simply means no target. */
function runtimeEnvironmentsFromStore(): readonly ManagedOrcadEnvironmentSummary[] | undefined {
  return useAppStore.getState()?.runtimeEnvironments
}

/**
 * The proxy env a terminal created on this SSH host inherits, read from the target's own settings.
 * Read per create so a settings edit reaches the next terminal without reconnecting the host.
 */
export async function resolveSshHostProxyEnvForTarget(args: {
  targetId: string
  listTargets: () => Promise<readonly SshHostProxyTarget[]>
}): Promise<Record<string, string>> {
  const targets = await args.listTargets()
  return buildConfiguredProxyEnv(targets.find((target) => target.id === args.targetId))
}

/**
 * Same resolution wired to this client's store and IPC. Answers `{}` for anything that is not one of
 * this client's SSH hosts, including paired clients that have no SSH target surface at all.
 */
export async function resolveSshHostProxyEnvForExecutionHost(
  executionHostId: string | null | undefined
): Promise<Record<string, string>> {
  const targetId = sshTargetIdForExecutionHostFromStore(executionHostId)
  const listTargets = window.api?.ssh?.listTargets
  if (!targetId || typeof listTargets !== 'function') {
    return {}
  }
  return resolveSshHostProxyEnvForTarget({ targetId, listTargets })
}

/**
 * `env` with the host's own proxy on top, so a host setting outranks a forwarded pane env; explicit
 * `envToDelete` entries still win because the host applies deletions after the merge.
 */
export function withSshHostProxyEnv(
  env: Record<string, string> | undefined,
  hostProxyEnv: Record<string, string>
): Record<string, string> | undefined {
  return Object.keys(hostProxyEnv).length > 0 ? { ...env, ...hostProxyEnv } : env
}
