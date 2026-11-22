import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../../../appearance/native-chat-appearance-style'
import { NativeChatBackgroundTasksStatus } from '../NativeChatBackgroundTasksStatus'
import { NativeChatWorkerDockFrame } from './NativeChatWorkerDockFrame'
import type { WorkerDockRowView } from './WorkerDockRow'

// A bot's Home Chat that started three workers with `orca orchestration worker-start`.
const SOURCE = '6c3f8e4a-ad5b-4a9c-9e37-2f4d8a0b3c59'
const minutes = (count: number) => Date.now() - count * 60_000

function worker(
  index: number,
  name: string,
  title: string,
  state: WorkerDockRowView['state'],
  startedMinutesAgo: number
): WorkerDockRowView {
  return {
    kind: 'worker',
    id: `dock:${index}`,
    dispatchId: `ctx_bot_${index}`,
    source: SOURCE,
    name,
    title,
    model: 'gpt-6.1-sol',
    state,
    changedAt: minutes(state === 'needs-you' ? 1 : startedMinutesAgo),
    startedAt: minutes(startedMinutesAgo),
    reason: null,
    settlement: null,
    resultId: null,
    stoppable: state !== 'needs-you',
    ownerActionsAvailable: true
  }
}

const rows = [
  worker(1, 'ORCA-18', 'Fix streaming journal amplification', 'running', 12),
  worker(2, 'ORCA-19', 'Fix repeated worktree catalog scans', 'running', 9),
  worker(3, 'ORCA-20', 'Approve: run the migration against the staging copy', 'needs-you', 6)
]
const workerRows = new Map(rows.map((row) => [row.id, row]))
const workerIdentities = rows.map(({ id, state, changedAt }) => ({ id, state, changedAt }))

function botChat(expanded: boolean) {
  return (
    <div
      className="native-chat-appearance flex flex-col gap-2 bg-chat-canvas p-3"
      style={nativeChatAppearanceStyle({})}
    >
      <p className="text-xs text-muted-foreground">Perf Issue · Home Chat</p>
      <p className="text-sm text-chat-foreground">
        Both fix workers are running in parallel; ORCA-20 needs your approval.
      </p>
      <div className="rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs">
        <NativeChatWorkerDockFrame>
          <NativeChatBackgroundTasksStatus
            sessionId={SOURCE}
            tasks={[]}
            settledTasks={[]}
            supportsTaskStop
            offersStopAll={false}
            stoppingTaskIds={new Set()}
            stoppingAll={false}
            indicatorActive
            isVisible
            expanded={expanded}
            onExpandedChange={() => {}}
            onStop={() => {}}
            workerRows={workerRows}
            workerIdentities={workerIdentities}
            ownerActionsAvailable
          />
        </NativeChatWorkerDockFrame>
        <p className="px-2 py-2 text-sm text-muted-foreground">
          Ask anything, / for commands, @ for context
        </p>
      </div>
    </div>
  )
}

export const botHomeChatFolded = defineFixture({ width: 720, render: () => botChat(false) })

export const botHomeChatOpen = defineFixture({ width: 720, render: () => botChat(true) })

export const botHomeChatNarrowFolded = defineFixture({ width: 390, render: () => botChat(false) })

export const botHomeChatNarrowOpen = defineFixture({ width: 390, render: () => botChat(true) })
