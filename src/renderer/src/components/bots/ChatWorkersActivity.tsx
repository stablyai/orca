import { useTranslate } from '@/i18n/use-translate'
import { useFocusedChatWorkers } from '@/lib/focused-chat-workers'
import { openOrchestrationWorker } from '@/lib/open-orchestration-worker'
import { canStopOrchestrationWorker } from '@/lib/stop-orchestration-worker'
import { sessionWorkerLook } from '@/lib/orchestration-session-worker-status'
import {
  sessionWorkerIsRunning,
  sessionWorkerNeverStarted,
  type OrchestrationSessionWorker
} from '../../../../shared/orchestration-session-workers'
import { ActivitySection, workersHeading } from './ActivitySection'
import { WorkerActivityRow } from './WorkerActivityRow'

/** The focused chat's workers: open ones (counted only while working), then those that ended; all under "Workers" once none is open. */
export function ChatWorkersActivity(): React.JSX.Element | null {
  const t = useTranslate()
  const { tab, target, workers } = useFocusedChatWorkers(true)
  if (!tab || workers.length === 0) {
    return null
  }
  const chatName = tab.customLabel ?? tab.label
  const origin = t('bots.activity.startedIn', 'Started in {{name}}', { name: chatName })
  const running = workers.filter(sessionWorkerIsRunning)
  const ended = workers.filter((worker) => !sessionWorkerIsRunning(worker))
  const row = (worker: OrchestrationSessionWorker): React.JSX.Element => (
    <WorkerActivityRow
      key={worker.dispatchId}
      dispatchId={worker.dispatchId}
      title={worker.title}
      dot={null}
      running={sessionWorkerIsRunning(worker)}
      origin={origin}
      coordinator={chatName}
      workspaceId={worker.worktreeId}
      worker={worker}
      canStop={canStopOrchestrationWorker(target)}
      onOpen={
        sessionWorkerNeverStarted(worker)
          ? undefined
          : () => openOrchestrationWorker(worker, target)
      }
    />
  )
  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 py-3">
      {running.length > 0 ? (
        <>
          <ActivitySection
            title={workersHeading(
              running.filter((worker) => sessionWorkerLook(worker).group === 'working').length
            )}
          >
            {running.map(row)}
          </ActivitySection>
          {ended.length > 0 ? (
            <ActivitySection title={t('bots.activity.completed', 'Completed')}>
              {ended.map(row)}
            </ActivitySection>
          ) : null}
        </>
      ) : (
        <ActivitySection title={workersHeading(0)}>{ended.map(row)}</ActivitySection>
      )}
    </div>
  )
}
