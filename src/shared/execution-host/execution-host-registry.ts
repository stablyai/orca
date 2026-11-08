import {
  LOCAL_EXECUTION_HOST_ID,
  getLocalExecutionHostLabel,
  getSettingsFocusedExecutionHostId,
  getRepoDialableSshTargetId,
  isOwnedSshTargetId,
  normalizeHostPart,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type { SshConnectionState } from '../ssh-types'
import type { RuntimeEnvironmentSource } from '../remote-runtime/host-catalog/runtime-environments'
import type { GlobalSettings } from '../global-settings-types'
import type { Repo } from '../repo-types'
import { annotateManagedOrcadExecutionHosts } from './managed-orcad-execution-host'
import { getSshConnectionHealth } from './execution-host-health'
import type {
  ExecutionHostRegistryEntry,
  RuntimeStatusByEnvironmentId,
  ExecutionHostSource,
  RuntimeEnvironmentSummary
} from './execution-host-registry-entry'
import {
  runtimeCompatibility,
  runtimeControlHealth,
  runtimeHealth
} from './runtime-execution-host-health'

function setHost(
  hosts: Map<ExecutionHostId, ExecutionHostRegistryEntry>,
  entry: ExecutionHostRegistryEntry
): void {
  const existing = hosts.get(entry.id)
  if (!existing) {
    hosts.set(entry.id, entry)
    return
  }
  if (existing.health !== 'disconnected') {
    return
  }
  // Health upgrades must retain the first friendly label/source seeded before id-only fallbacks.
  hosts.set(entry.id, { ...entry, label: existing.label, source: existing.source ?? entry.source })
}

function addRuntimeHost(
  hosts: Map<ExecutionHostId, ExecutionHostRegistryEntry>,
  environmentId: string,
  label: string,
  source: RuntimeEnvironmentSource | undefined,
  statusByEnvironmentId: RuntimeStatusByEnvironmentId | undefined
): void {
  const hostId = toRuntimeExecutionHostId(environmentId)
  const runtimeStatus = statusByEnvironmentId?.get(environmentId)
  const status = runtimeStatus?.status
  const snapshot = runtimeStatus?.snapshot
  const metadata = status ?? snapshot?.status
  const compatibility = runtimeCompatibility(metadata)
  const remoteControl = runtimeStatus?.remoteControl ?? status?.remoteControl
  // Status owners withdraw verified on socket loss, so it proves reachability while shared control connects (#10704).
  const reachable =
    snapshot?.transport === 'ready'
      ? snapshot.verification !== 'checking'
      : snapshot?.verification === 'verified' && snapshot.transport !== 'disconnected'
  const controlHealth = snapshot?.retired
    ? 'disconnected'
    : snapshot?.verification === 'blocked'
      ? 'blocked'
      : reachable
        ? compatibility?.kind === 'blocked'
          ? 'blocked'
          : 'available'
        : !runtimeStatus ||
            snapshot?.verification === 'checking' ||
            snapshot?.transport === 'disconnected' ||
            snapshot?.transport === 'connecting'
          ? 'connecting'
          : runtimeControlHealth(remoteControl)
  const health = controlHealth ?? runtimeHealth(status, compatibility, remoteControl)
  const blockedReason =
    health === 'blocked'
      ? (snapshot?.verification === 'blocked' && snapshot.blockedReason) || 'incompatible'
      : undefined
  setHost(hosts, {
    id: hostId,
    kind: 'runtime',
    label,
    detail: 'Orca server',
    health,
    ...(blockedReason ? { blockedReason } : {}),
    compatibility: compatibility ?? undefined,
    capabilities: metadata?.capabilities,
    appVersion: runtimeStatus?.appVersion ?? metadata?.appVersion ?? null,
    protocolVersion: metadata?.runtimeProtocolVersion ?? metadata?.protocolVersion ?? null,
    minCompatibleClientVersion:
      metadata?.minCompatibleRuntimeClientVersion ?? metadata?.minCompatibleMobileVersion ?? null,
    platform: metadata?.hostPlatform ?? null,
    remoteControlState: remoteControl ?? null,
    ...(source ? { source } : {})
  })
}

export function buildExecutionHostRegistry(args: {
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  hostSource?: ExecutionHostSource
  sshTargetLabels?: ReadonlyMap<string, string>
  sshConnectionStates?: ReadonlyMap<string, SshConnectionState>
  runtimeEnvironments?: readonly RuntimeEnvironmentSummary[]
  runtimeStatusByEnvironmentId?: RuntimeStatusByEnvironmentId
  // Per-host user labels must appear wherever this registry feeds.
  hostLabelOverrides?: ReadonlyMap<ExecutionHostId, string>
  /** Defaults to this process's platform, which only the host itself may use. */
  localHostLabel?: string
}): ExecutionHostRegistryEntry[] {
  const hosts = new Map<ExecutionHostId, ExecutionHostRegistryEntry>()
  hosts.set(LOCAL_EXECUTION_HOST_ID, {
    id: LOCAL_EXECUTION_HOST_ID,
    kind: 'local',
    label: args.localHostLabel ?? getLocalExecutionHostLabel(),
    detail: 'This computer',
    health: 'local'
  })

  for (const environment of args.runtimeEnvironments ?? []) {
    const environmentId = normalizeHostPart(environment.id)
    if (!environmentId) {
      continue
    }
    addRuntimeHost(
      hosts,
      environmentId,
      normalizeHostPart(environment.name) ?? environmentId,
      environment.source,
      args.runtimeStatusByEnvironmentId
    )
  }
  for (const environmentId of args.runtimeStatusByEnvironmentId?.keys() ?? []) {
    addRuntimeHost(
      hosts,
      environmentId,
      environmentId,
      undefined,
      args.runtimeStatusByEnvironmentId
    )
  }

  const focusedHost = getSettingsFocusedExecutionHostId(args.settings)
  const parsedFocusedHost = parseExecutionHostId(focusedHost)
  if (parsedFocusedHost?.kind === 'runtime' && args.hostSource !== 'configured-only') {
    addRuntimeHost(
      hosts,
      parsedFocusedHost.environmentId,
      parsedFocusedHost.environmentId,
      undefined,
      args.runtimeStatusByEnvironmentId
    )
  }

  const sshTargetIds = new Set<string>()
  if (args.hostSource !== 'configured-only') {
    for (const repo of args.repos) {
      const parsedHost = parseExecutionHostId(repo.executionHostId)
      if (parsedHost?.kind === 'runtime') {
        addRuntimeHost(
          hosts,
          parsedHost.environmentId,
          parsedHost.environmentId,
          undefined,
          args.runtimeStatusByEnvironmentId
        )
      }
      // VM-owned SSH targets are plumbing and must stay out of visible run targets.
      if (parsedHost?.kind === 'ssh' && !isOwnedSshTargetId(parsedHost.targetId)) {
        sshTargetIds.add(parsedHost.targetId)
      }
    }
  }
  for (const targetId of args.sshTargetLabels?.keys() ?? []) {
    const normalized = normalizeHostPart(targetId)
    if (normalized && !isOwnedSshTargetId(normalized)) {
      sshTargetIds.add(normalized)
    }
  }
  if (args.hostSource !== 'configured-only') {
    for (const repo of args.repos) {
      // A paired-server repo’s raw connectionId belongs to that server and is not client-dialable.
      const targetId = getRepoDialableSshTargetId(repo)
      if (targetId && !isOwnedSshTargetId(targetId)) {
        sshTargetIds.add(targetId)
      }
    }
  }

  for (const targetId of sshTargetIds) {
    const state = args.sshConnectionStates?.get(targetId)
    setHost(hosts, {
      id: toSshExecutionHostId(targetId),
      kind: 'ssh',
      label: args.sshTargetLabels?.get(targetId) || targetId,
      detail: 'SSH',
      health: getSshConnectionHealth(state?.status),
      connectionStatus: state?.status
    })
  }

  annotateManagedOrcadExecutionHosts({
    hosts,
    runtimeEnvironments: args.runtimeEnvironments ?? [],
    sshConnectionStates: args.sshConnectionStates
  })

  const overrides = args.hostLabelOverrides
  if (!overrides || overrides.size === 0) {
    return [...hosts.values()]
  }
  return [...hosts.values()].map((host) => {
    // A rename on a merged-away alias still names the merged row.
    const label =
      overrides.get(host.id) ??
      host.aliasHostIds?.map((aliasHostId) => overrides.get(aliasHostId)).find(Boolean)
    return label ? { ...host, label } : host
  })
}
