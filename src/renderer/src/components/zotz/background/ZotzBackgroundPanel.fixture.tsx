import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatBackgroundTasksStatus } from '../../native-chat/tools/tasks/NativeChatBackgroundTasksStatus'
import type { AgentSessionBackgroundTask } from '../../../../../shared/agent-session/agent-session-background-task-wire'
import ZotzBackgroundPanel from './ZotzBackgroundPanel'
import { ZotzBackgroundTasksPortal } from './ZotzBackgroundTasksPortal'

const now = Date.now()
const tasks: AgentSessionBackgroundTask[] = [
  {
    id: 'tests',
    kind: 'command',
    description: 'pnpm test src/main/zotz --maxWorkers=4',
    state: 'working',
    startedAt: now - 95_000
  },
  {
    id: 'dev',
    kind: 'command',
    description: 'pnpm dev',
    state: 'monitoring',
    startedAt: now - 12 * 60_000
  },
  {
    id: 'review',
    kind: 'agent',
    description: 'Revisar el diff antes del PR',
    state: 'working',
    startedAt: now - 40_000
  }
]

function PanelWithTasks(): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  return (
    <div className="flex h-[360px] flex-col border border-border bg-background">
      <ZotzBackgroundPanel />
      <ZotzBackgroundTasksPortal active>
        <NativeChatBackgroundTasksStatus
          isVisible
          tasks={tasks}
          settledTasks={[]}
          supportsTaskStop
          offersStopAll
          stoppingTaskIds={new Set()}
          stoppingAll={false}
          indicatorActive
          expanded={expanded}
          onExpandedChange={setExpanded}
          onStop={() => {}}
        />
      </ZotzBackgroundTasksPortal>
    </div>
  )
}

export const withTasks = defineFixture({
  width: 340,
  render: () => <PanelWithTasks />
})

export const empty = defineFixture({
  width: 340,
  render: () => (
    <div className="flex h-[240px] flex-col border border-border bg-background">
      <ZotzBackgroundPanel />
    </div>
  )
})
