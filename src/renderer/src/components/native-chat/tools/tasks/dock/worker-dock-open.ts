import { openOrchestrationCrewAgent } from '@/lib/agent-session/open/open-agent-message-sender'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WorkerDockRowView } from './WorkerDockRow'
import type { WorkerDockElsewhereEntry } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { translate } from '@/i18n/i18n'

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

/** Opens the chat an Other chats row counts work in; one whose place is unknown says so in a toast. */
export function openWorkerDockElsewhere(
  entry: WorkerDockElsewhereEntry,
  target: RuntimeClientTarget
): void {
  void openOrchestrationCrewAgent(
    {
      partyKey: `elsewhere:${entry.source}`,
      role: 'worker',
      label:
        entry.title?.trim() ||
        translate('components.native-chat.workerDock.untitledChat', 'Untitled chat'),
      agentKind: 'unknown',
      status: 'running',
      ...(entry.workspaceId
        ? {
            openTarget: {
              kind: 'chat' as const,
              worktreeId: entry.workspaceId,
              sessionId: entry.sessionId
            }
          }
        : {})
    },
    target
  )
}
