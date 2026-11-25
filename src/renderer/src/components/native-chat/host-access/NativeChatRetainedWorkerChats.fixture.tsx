import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '../../../store'
import type { OrchestrationSessionWorker } from '../../../../../shared/orchestration-session-workers'
import { useNativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import { NativeChatComposer } from '../composer/NativeChatComposer'
import { NativeChatContextClearFade } from '../conversation/projection/NativeChatContextClearFade'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { RetainedWorkerChatList } from './NativeChatRetainedWorkerChats'

const HOUR = 60 * 60_000

function worker(dispatchId: string, title: string, minutes: number): OrchestrationSessionWorker {
  const settledAt = Date.now() - HOUR
  return {
    dispatchId,
    taskId: `task_${dispatchId}`,
    runId: 'run_fixture',
    title,
    agent: 'codex',
    state: 'completed',
    liveness: 'exited',
    host: 'local',
    worktreeId: 'wt-fixture',
    paneKey: null,
    chatSessionId: `chat_${dispatchId}`,
    startedAt: settledAt - minutes * 60_000,
    settledAt
  }
}

const WORKERS = [
  worker('ctx_review2', 'Final review of the export fix', 6),
  worker('ctx_review1', 'Review the export fix', 9),
  worker('ctx_impl', 'Fix CSV export dropping the last row', 24)
]

function EmptyPaneWithWorkers({ height }: { height: number }) {
  const settings = useAppStore((state) => state.settings)
  const appearance = useNativeChatAppearanceStyle(settings)
  return (
    <div
      className="native-chat-appearance bg-chat-canvas flex min-h-0 w-full flex-col overflow-hidden"
      style={{ ...appearance, height }}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <NativeChatContextClearFade clearing={false}>
          <NativeChatEmptyState kind="empty" agent="codex">
            <RetainedWorkerChatList workers={WORKERS} onOpen={() => {}} />
          </NativeChatEmptyState>
        </NativeChatContextClearFade>
      </div>
      <NativeChatComposer
        terminalTabId="fixture-retained"
        paneKey="fixture-retained"
        targetPtyId="fixture-retained"
        agent="codex"
      />
    </div>
  )
}

export const finishedWorkers = defineFixture({
  width: 849,
  render: () => <EmptyPaneWithWorkers height={600} />
})
