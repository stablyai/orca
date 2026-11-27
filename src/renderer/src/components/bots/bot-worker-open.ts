import { openOrchestrationWorker, revealWorkerPane } from '@/lib/open-orchestration-worker'
import type { BotWorkerRow } from '../../../../shared/bots/bot-activity-model'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** What a click on a bot's worker row opens, wherever the row is listed; null when nothing can.
 *  `target` is the host that runs the bot, where its workers' Dispatches live. */
export function botWorkerRowOpener(
  row: BotWorkerRow,
  target: RuntimeClientTarget
): (() => void) | null {
  const { worker, workspaceId } = row
  // A handed agent has no Dispatch to reopen; reveal its pane where it runs.
  if (!worker && !row.dispatchId) {
    return workspaceId ? () => revealWorkerPane(workspaceId, row.paneKey, row.hostId) : null
  }
  return () =>
    openOrchestrationWorker(
      worker ?? { ...row, worktreeId: workspaceId, chatSessionId: null },
      target
    )
}
