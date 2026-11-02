import { parseExecutionHostId, type ExecutionHostId } from './execution-host'
import { buildExecutionHostRegistry, type ExecutionHostHealth } from './execution-host-registry'
import {
  pickerExecutionHosts,
  type ManagedOrcadDeploymentSummary
} from './managed-orcad-execution-host'
import type { RuntimeCompatVerdict } from './protocol-compat'
import type { RuntimeEnvironmentSource } from './runtime-environments'
import type { RuntimeEnvironmentStatus } from './runtime-host-status'
import type { SshConnectionState } from './ssh-types'
import { getPairedDeviceIdsByEnvironment } from './workspace-creator-visibility'

export type PairedServerHostInputs = {
  environments: readonly {
    id: string
    name?: string | null
    source?: RuntimeEnvironmentSource
    orcadDeployment?: ManagedOrcadDeploymentSummary | null
    pairedDeviceId?: string
  }[]
  statusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
  sshTargetLabels: ReadonlyMap<string, string>
  sshConnectionStates: ReadonlyMap<string, SshConnectionState>
  hostLabelOverrides: ReadonlyMap<ExecutionHostId, string>
}

/** A configured server's header facts: health and compatibility from the desktop's own status. */
export type PairedServerHost = {
  hostId: `runtime:${string}`
  environmentId: string
  label: string
  health: ExecutionHostHealth
  compatibility: RuntimeCompatVerdict['kind'] | null
  /** The desktop's own device id on that server, which "Hide other devices" compares against. */
  pairedDeviceId: string | null
}

/** The servers the desktop shows, as its sidebar maps them; a managed server folds into its SSH host. */
export function describePairedServerHosts(inputs: PairedServerHostInputs): PairedServerHost[] {
  const deviceIds = getPairedDeviceIdsByEnvironment(
    inputs.environments,
    inputs.statusByEnvironmentId
  )
  const configured = new Set(inputs.environments.map((environment) => environment.id))
  return pickerExecutionHosts(
    buildExecutionHostRegistry({
      repos: [],
      settings: null,
      hostSource: 'configured-only',
      sshTargetLabels: inputs.sshTargetLabels,
      sshConnectionStates: inputs.sshConnectionStates,
      runtimeEnvironments: inputs.environments,
      runtimeStatusByEnvironmentId: inputs.statusByEnvironmentId,
      hostLabelOverrides: inputs.hostLabelOverrides
    })
  ).flatMap((entry) => {
    const parsed = parseExecutionHostId(entry.id)
    if (parsed?.kind !== 'runtime' || !configured.has(parsed.environmentId)) {
      return []
    }
    return [
      {
        hostId: parsed.id,
        environmentId: parsed.environmentId,
        label: entry.label,
        health: entry.health,
        compatibility: entry.compatibility?.kind ?? null,
        pairedDeviceId: deviceIds.get(parsed.environmentId) ?? null
      }
    ]
  })
}
