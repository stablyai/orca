// The hosts S3 lists, from what the renderer already holds (no probe, no connect). Orca Cloud
// sandboxes are left out: one "Orca Cloud" row stands for all of them.
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { selectEphemeralVmHostLifecycles } from '@/store/slices/ephemeral-vm/ephemeral-vm-lifecycle'
import { buildExecutionHostRegistry } from '../../../../../../shared/execution-host/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../../../../shared/host-setting-overrides'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { agentHostAvailability, agentHostKind } from '../../../agent-host-panel/agent-host-kind'
import { selectStartableStoppedWslDistro } from '../../../wsl-host-stopped/use-stopped-wsl-host'
import type { OverviewHost } from './agent-accounts-overview-model'

export function useOverviewHosts(): OverviewHost[] {
  const repos = useAppStore((s) => s.repos)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const ephemeralVmHosts = useAppStore(selectEphemeralVmHostLifecycles)
  const stoppedWsl = useAppStore((s) =>
    s.runtimeEnvironments
      .filter((environment) => selectStartableStoppedWslDistro(s, environment.id) !== null)
      .map((environment) => environment.id)
      .join('\u0000')
  )
  return useMemo(() => {
    const stopped = new Set(stoppedWsl.split('\u0000'))
    const registry = buildExecutionHostRegistry({
      repos,
      // The overview lists every host; it never routes by the focused one.
      settings: null,
      sshTargetLabels,
      sshConnectionStates,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      hostLabelOverrides: getHostDisplayLabelOverrides(settings),
      ephemeralVmHosts
    })
    const hosts: OverviewHost[] = []
    for (const entry of registry) {
      const parsed = parseExecutionHostId(entry.id)
      const environmentId = parsed?.kind === 'runtime' ? parsed.environmentId : null
      const environment = environmentId
        ? (runtimeEnvironments.find((candidate) => candidate.id === environmentId) ?? null)
        : null
      const kind = agentHostKind(entry.kind, environment)
      if (kind === 'cloud') {
        continue
      }
      hosts.push({
        hostId: entry.id,
        label: entry.label,
        kind,
        availability: agentHostAvailability(kind, {
          health: entry.health,
          wslStopped: environmentId !== null && stopped.has(environmentId)
        }),
        health: entry.health,
        environmentId
      })
    }
    return hosts
  }, [
    repos,
    sshTargetLabels,
    sshConnectionStates,
    settings,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    ephemeralVmHosts,
    stoppedWsl
  ])
}
