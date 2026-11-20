import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatBackgroundTasksStatus } from '../../native-chat/tools/tasks/NativeChatBackgroundTasksStatus'
import type { AgentSessionBackgroundTask } from '../../../../../shared/agent-session/agent-session-background-task-wire'
import ZotzBackgroundPanel from './ZotzBackgroundPanel'
import { ZotzBackgroundTasksPortal } from './ZotzBackgroundTasksPortal'
import type { ZotzBackgroundTaskOutputs } from './zotz-background-task-outputs'

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
    id: 'codex-command:primary:call-dev',
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

const testOutput = [
  ' RUN  v5.0.5 /Users/me/code/zotz',
  '',
  ' ✓ src/main/zotz/zotz-cli-auto-registration.test.ts (3 tests) 12ms',
  ' ✓ src/main/zotz/zotz-network-policy-guards.test.ts (3 tests) 18ms',
  ' ✓ src/main/zotz/zotz-tailnet-source-guard.test.ts (6 tests) 31ms',
  ' ❯ src/main/zotz/memory-governor/zotz-agent-launch-queue.test.ts (9 tests)',
  '',
  ' Test Files  3 passed | 1 running (4)',
  '      Tests  12 passed (21)'
].join('\n')

// The test run published an output file; `pnpm dev` came from an agent that only streams it into the chat.
const outputs: ZotzBackgroundTaskOutputs = {
  worktreeId: 'zotz::/Users/me/code/zotz',
  outputFiles: new Map([['tests', '/private/tmp/claude-501/tasks/tests.output']]),
  callOutputs: {
    byCall: new Map([
      [
        'call-dev',
        '> zotz@1.4.0 dev\n> electron-vite dev\n\n  VITE ready in 812 ms\n  ➜  Local: http://localhost:5173/'
      ]
    ]),
    callByTask: new Map()
  },
  read: async () => testOutput
}

function PanelWithTasks({ height = 360 }: { height?: number }): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  return (
    <div style={{ height }} className="flex flex-col border border-border bg-background">
      <ZotzBackgroundPanel />
      <ZotzBackgroundTasksPortal active outputs={outputs}>
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

// A shell row expands to its output; the agent row keeps opening its chat.
export const shellExpanded = defineFixture({
  width: 340,
  render: () => <PanelWithTasks height={560} />,
  interact: async () => {
    for (const label of ['pnpm test', 'pnpm dev']) {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'))
        .find((button) => button.textContent?.includes(label))
        ?.click()
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
})
