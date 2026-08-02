import {
  LOCAL_EXECUTION_HOST_ID,
  getLocalExecutionHostLabel,
  getSettingsFocusedExecutionHostId,
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostKind
} from './execution-host'
import { evaluateRuntimeCompat, type RuntimeCompatVerdict } from './protocol-compat'
import { MIN_COMPATIBLE_RUNTIME_SERVER_VERSION, RUNTIME_PROTOCOL_VERSION } from './protocol-version'
import type { RuntimeStatus } from './runtime-types'
import type { SshConnectionState, SshConnectionStatus } from './ssh-types'
import type { RuntimeEnvironmentSource } from './runtime-environments'
import type { GlobalSettings, Repo } from './types'

export type ExecutionHostHealth =
  | 'local'
  | 'available'
  | 'connecting'
  | 'blocked'
  | 'disconnected'
  | 'error'

export type ExecutionHostRegistryEntry = {
  id: ExecutionHostId
  kind: ExecutionHostKind
  label: string
  detail: string
  health: ExecutionHostHealth
  connectionStatus?: SshConnectionStatus
  compatibility?: RuntimeCompatVerdict
  capabilities?: readonly string[]
  appVersion?: string | null
  protocolVersion?: number | null
  minCompatibleClientVersion?: number | null
  platform?: NodeJS.Platform | null
  remoteControlState?: RuntimeStatus['remoteControl']
  source?: RuntimeEnvironmentSource
}

type RuntimeEnvironmentSummary = {
  id: string
  name?: string | null
  source?: RuntimeEnvironmentSource
}

type RuntimeHostStatus = {
  status?: RuntimeStatus | null
  appVersion?: string | null
}

type RuntimeStatusByEnvironmentId = ReadonlyMap<string, RuntimeHostStatus>

function normalizeHostPart(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function runtimeCompatibility(
  status: RuntimeStatus | null | undefined
): RuntimeCompatVerdict | null {
  if (!status) {
    return null
  }
  return evaluateRuntimeCompat({
    clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
    serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
    serverMinCompatibleClientProtocolVersion:
      status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
  })
}

function runtimeHealth(
  status: RuntimeStatus | null | undefined,
  compatibility: RuntimeCompatVerdict | null
): ExecutionHostHealth {
  // Why: with no live status we have no evidence the Orca server is reachable, so
  // it must read 'disconnected' (like SSH) rather than defaulting to 'available'.
  // A configured-but-never-connected host was showing "Connected" otherwise.
  if (!status) {
    return 'disconnected'
  }
  if (!compatibility) {
    return 'available'
  }
  return compatibility.kind === 'blocked' ? 'blocked' : 'available'
}

function runtimeControlHealth(
  remoteControl: RuntimeStatus['remoteControl'] | null | undefined
): ExecutionHostHealth | null {
  switch (remoteControl?.state) {
    case 'awaiting_authenticated':
    case 'awaiting_ready':
    case 'reconnecting':
      return 'connecting'
    case 'closed':
      return remoteControl.lastError ? 'error' : 'disconnected'
    case 'ready':
      return null
    case undefined:
      return null
  }
}

function sshHealth(state: SshConnectionState | undefined): ExecutionHostHealth {
  switch (state?.status) {
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
  // Why: a later status-bearing registration may upgrade health, but the first
  // (named) registration is authoritative for the label — runtime envs are
  // seeded with a friendly name before the id-labeled status/focus/repo
  // fallbacks run, so keep the existing label on a health-only upgrade.
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
  const compatibility = runtimeCompatibility(status)
  const controlHealth = runtimeControlHealth(status?.remoteControl)
  setHost(hosts, {
    id: hostId,
    kind: 'runtime',
    label,
    detail: 'Orca server',
    health: controlHealth ?? runtimeHealth(status, compatibility),
    compatibility: compatibility ?? undefined,
    capabilities: status?.capabilities,
    appVersion: runtimeStatus?.appVersion ?? status?.appVersion ?? null,
    protocolVersion: status?.runtimeProtocolVersion ?? status?.protocolVersion ?? null,
    minCompatibleClientVersion:
      status?.minCompatibleRuntimeClientVersion ?? status?.minCompatibleMobileVersion ?? null,
    platform: status?.hostPlatform ?? null,
    remoteControlState: status?.remoteControl ?? null,
    ...(source ? { source } : {})
  })
}

export function buildExecutionHostRegistry(args: {
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  sshTargetLabels?: ReadonlyMap<string, string>
  sshConnectionStates?: ReadonlyMap<string, SshConnectionState>
  runtimeEnvironments?: readonly RuntimeEnvironmentSummary[]
  runtimeStatusByEnvironmentId?: RuntimeStatusByEnvironmentId
  // Why: user-chosen per-host display labels override the derived label so a
  // rename in the host menu/settings shows everywhere the registry feeds.
  hostLabelOverrides?: ReadonlyMap<ExecutionHostId, string>
}): ExecutionHostRegistryEntry[] {
  const hosts = new Map<ExecutionHostId, ExecutionHostRegistryEntry>()
  hosts.set(LOCAL_EXECUTION_HOST_ID, {
    id: LOCAL_EXECUTION_HOST_ID,
    kind: 'local',
    label: getLocalExecutionHostLabel(),
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
  if (parsedFocusedHost?.kind === 'runtime') {
    addRuntimeHost(
      hosts,
      parsedFocusedHost.environmentId,
      parsedFocusedHost.environmentId,
      undefined,
      args.runtimeStatusByEnvironmentId
    )
  }

  const sshTargetIds = new Set<string>()
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
    // Why: a VM-backed repo's executionHostId is `ssh:runtime-ssh-<id>`. Runtime-owned
    // targets are hidden, so they must not become visible SSH run-target hosts here.
    if (parsedHost?.kind === 'ssh' && !isRuntimeOwnedSshTargetId(parsedHost.targetId)) {
      sshTargetIds.add(parsedHost.targetId)
    }
  }
  for (const targetId of args.sshTargetLabels?.keys() ?? []) {
    const normalized = normalizeHostPart(targetId)
    if (normalized && !isRuntimeOwnedSshTargetId(normalized)) {
      sshTargetIds.add(normalized)
    }
  }
  for (const repo of args.repos) {
    const targetId = normalizeHostPart(repo.connectionId)
    if (targetId && !isRuntimeOwnedSshTargetId(targetId)) {
      sshTargetIds.add(targetId)
    }
  }

  for (const targetId of sshTargetIds) {
    const state = args.sshConnectionStates?.get(targetId)
    setHost(hosts, {
      id: toSshExecutionHostId(targetId),
      kind: 'ssh',
      label: args.sshTargetLabels?.get(targetId) || targetId,
      detail: 'SSH',
      health: sshHealth(state),
      connectionStatus: state?.status
    })
  }

  const overrides = args.hostLabelOverrides
  if (!overrides || overrides.size === 0) {
    return [...hosts.values()]
  }
  return [...hosts.values()].map((host) => {
    const label = overrides.get(host.id)
    return label ? { ...host, label } : host
  })
}
