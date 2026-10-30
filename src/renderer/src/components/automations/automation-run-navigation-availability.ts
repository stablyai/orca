import type { AutomationRunOpenTarget } from '../../../../shared/automation-run-outcome'
import { parseExecutionHostId } from '../../../../shared/execution-host'

export function automationRunNavigationAvailability(
  target: Pick<AutomationRunOpenTarget, 'hostId' | 'pairingRevision'>,
  environments: readonly { id: string; pairingRevision?: number }[],
  settled: boolean
): 'loading' | 'stale' | 'ready' {
  const host = parseExecutionHostId(target.hostId)
  if (host?.kind !== 'runtime' || target.pairingRevision === undefined) {
    return 'ready'
  }
  if (!settled) {
    return 'loading'
  }
  return environments.find((environment) => environment.id === host.environmentId)
    ?.pairingRevision === target.pairingRevision
    ? 'ready'
    : 'stale'
}
