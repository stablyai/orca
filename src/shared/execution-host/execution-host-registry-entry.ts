import type {
  RuntimeEnvironmentStatus,
  RuntimeHostBlockedReason
} from '../remote-runtime/host-status/runtime-host-status'
import type { ExecutionHostId, ExecutionHostKind } from '../execution-host'
import type { RuntimeCompatVerdict } from '../protocol-compat'
import type { RuntimeStatus } from '../runtime-session-contracts'
import type { SshConnectionStatus } from '../ssh-types'
import type { RuntimeEnvironmentSource } from '../remote-runtime/host-catalog/runtime-environments'
import type { ManagedOrcadDeploymentSummary } from './managed-orcad-execution-host'
import type { ExecutionHostHealth, ExecutionHostVmState } from './execution-host-health'

export type ExecutionHostRegistryEntry = {
  id: ExecutionHostId
  kind: ExecutionHostKind
  label: string
  isDefaultLocalLabel?: boolean
  detail: string
  health: ExecutionHostHealth
  connectionStatus?: SshConnectionStatus
  compatibility?: RuntimeCompatVerdict
  /** Present only while health is blocked; local evidence, never published to peers. */
  blockedReason?: RuntimeHostBlockedReason
  /** Present only while a VM-backed host's lifecycle, not its transport, explains its health. */
  vmState?: ExecutionHostVmState
  capabilities?: readonly string[]
  appVersion?: string | null
  protocolVersion?: number | null
  minCompatibleClientVersion?: number | null
  platform?: NodeJS.Platform | null
  remoteControlState?: RuntimeStatus['remoteControl']
  source?: RuntimeEnvironmentSource
  /** See managed-orcad-execution-host: pairs an SSH host with its managed server. */
  aliasHostIds?: readonly ExecutionHostId[]
  mergedIntoHostId?: ExecutionHostId
}

export type RuntimeEnvironmentSummary = {
  id: string
  name?: string | null
  source?: RuntimeEnvironmentSource
  orcadDeployment?: ManagedOrcadDeploymentSummary | null
}

export type RuntimeStatusByEnvironmentId = ReadonlyMap<string, RuntimeEnvironmentStatus>

export type ExecutionHostSource = 'configured-only' | 'include-references'
