import { openOrchestrationCrewAgent } from '@/lib/agent-session/open/open-agent-message-sender'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WorkerDockRowView } from './WorkerDockRow'

/** Opens a tray row's worker; a worker that can't be opened says why in a toast. */
export function openWorkerDockRow(row: WorkerDockRowView, target: RuntimeClientTarget): void {
  void openOrchestrationCrewAgent(
    {
      partyKey: row.id,
      role: 'worker',
      label: row.name,
      agentKind: 'unknown',
      status: row.state,
      openTarget: { kind: 'dispatch', address: `dispatch:${row.dispatchId}` }
    },
    target
  )
}
