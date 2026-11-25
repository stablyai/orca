import { ActivitySection, workersHeading } from '@/components/bots/ActivitySection'
import { WorkerActivityRow } from '@/components/bots/WorkerActivityRow'
import { openOrchestrationWorker } from '@/lib/open-orchestration-worker'
import { useWorkspaceRetainedChats } from '@/lib/orchestration-workspace-retained-chats'
import type { OrchestrationSessionWorker } from '../../../../../shared/orchestration-session-workers'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Finished workers whose chats Orca closed in this workspace; a click reopens one in its conversation. */
export function NativeChatRetainedWorkerChats(props: {
  worktreeId: string | null
  target: RuntimeClientTarget
}): React.JSX.Element | null {
  const workers = useWorkspaceRetainedChats(props.target, props.worktreeId)
  return (
    <RetainedWorkerChatList
      workers={workers}
      onOpen={(worker) => openOrchestrationWorker(worker, props.target)}
    />
  )
}

export function RetainedWorkerChatList({
  workers,
  onOpen
}: {
  workers: readonly OrchestrationSessionWorker[]
  onOpen: (worker: OrchestrationSessionWorker) => void
}): React.JSX.Element | null {
  if (workers.length === 0) {
    return null
  }
  return (
    <ActivitySection title={workersHeading(0)} className="mt-3 w-full max-w-sm text-left">
      {workers.map((worker) => (
        <WorkerActivityRow
          key={worker.dispatchId}
          dispatchId={worker.dispatchId}
          title={worker.title}
          dot={null}
          running={false}
          coordinator=""
          workspaceId={worker.worktreeId}
          worker={worker}
          detail={null}
          canStop={false}
          onOpen={() => onOpen(worker)}
        />
      ))}
    </ActivitySection>
  )
}
