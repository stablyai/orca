import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { NativeChatBackgroundTasksStatus } from '../NativeChatBackgroundTasksStatus'
import type { WorkerDockRowView } from './WorkerDockRow'
import type { AgentSessionBackgroundTask } from '../../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import { workerDockFixturePane } from './worker-dock-pane-fixture'

// Made-up chat: two orchestration workers, one subagent and background commands, so the card shows
// workers and background commands as separate groups. No real names, paths or commands.
const SOURCE = '0b7e2c1a-5d3f-4e8a-9c6b-1f2e3d4c5b6a'
const minutes = (count: number) => Date.now() - count * 60_000

function worker(
  index: number,
  name: string,
  title: string,
  state: WorkerDockRowView['state'] = 'running',
  extra: Partial<WorkerDockRowView> = {}
): WorkerDockRowView {
  return {
    kind: 'worker',
    id: `fixture-worker:${index}`,
    dispatchId: `ctx_fixture_${index}`,
    source: SOURCE,
    name,
    title,
    model: 'example-model',
    state,
    changedAt: minutes(index * 3),
    startedAt: minutes(index * 3),
    reason: null,
    settlement: null,
    resultId: null,
    stoppable: true,
    ownerActionsAvailable: true,
    ...extra
  }
}

const WORKERS = [
  worker(1, 'Task A', 'Draft the settings copy'),
  worker(2, 'Task B', 'Check the sample layout')
]
const SUBAGENT: AgentSessionBackgroundTask = {
  id: 'fixture-sub-1',
  kind: 'agent',
  description: 'Look through the example folder',
  state: 'working',
  startedAt: minutes(2),
  stoppable: true
}
const COMMAND: AgentSessionBackgroundTask = {
  id: 'fixture-shell-1',
  kind: 'command',
  description: 'npm run dev',
  state: 'working',
  startedAt: minutes(5),
  stoppable: true
}
const LONG_COMMAND: AgentSessionBackgroundTask = {
  id: 'fixture-shell-2',
  kind: 'command',
  description:
    'npm run test -- --watch --reporter=verbose example/alpha.test.ts example/beta.test.ts example/gamma.test.ts',
  state: 'working',
  startedAt: minutes(1),
  stoppable: true
}
const MONITOR: AgentSessionBackgroundTask = {
  id: 'fixture-monitor-1',
  kind: 'monitor',
  description: 'Watch the example build',
  state: 'monitoring',
  startedAt: minutes(4),
  stoppable: true
}
const FAILED_COMMAND = worker(9, 'Command', 'npm run lint', 'failed', {
  kind: 'command',
  model: null,
  changedAt: minutes(1),
  reason: 'Exited with code 1.',
  settlement: 'fixture-failure-1',
  stoppable: false
})

function dock(
  expanded: boolean,
  {
    workers = [],
    tasks = [],
    offersStopAll = false
  }: {
    workers?: readonly WorkerDockRowView[]
    tasks?: AgentSessionBackgroundTask[]
    offersStopAll?: boolean
  }
) {
  // The pane draws the chip's frame, as a chat's message list does.
  return (
    <NativeChatBackgroundTasksStatus
      sessionId={SOURCE}
      tasks={tasks}
      settledTasks={[]}
      supportsTaskStop={!offersStopAll}
      offersStopAll={offersStopAll}
      stoppingTaskIds={new Set()}
      stoppingAll={false}
      indicatorActive
      isVisible
      expanded={expanded}
      onExpandedChange={() => {}}
      onStop={() => {}}
      workerRows={new Map(workers.map((row) => [row.id, row]))}
      workerIdentities={workers}
      onWorkerAction={noop}
    />
  )
}

const noop = () => {}

function chat(expanded: boolean, input: Parameters<typeof dock>[1]) {
  return workerDockFixturePane(dock(expanded, input))
}

const AGENTS = { workers: WORKERS, tasks: [SUBAGENT] }
const COMMANDS = { tasks: [COMMAND, MONITOR] }
const MIXED = { workers: WORKERS, tasks: [SUBAGENT, COMMAND, MONITOR] }

export const agentsOnlyFolded = defineFixture({ width: 420, render: () => chat(false, AGENTS) })
export const commandsOnlyFolded = defineFixture({ width: 420, render: () => chat(false, COMMANDS) })
export const mixedFolded = defineFixture({ width: 420, render: () => chat(false, MIXED) })
export const agentsOnlyOpen = defineFixture({ width: 420, render: () => chat(true, AGENTS) })
export const commandsOnlyOpen = defineFixture({ width: 420, render: () => chat(true, COMMANDS) })
export const mixedOpen = defineFixture({ width: 420, render: () => chat(true, MIXED) })
export const mixedStopAllOpen = defineFixture({
  width: 420,
  render: () => chat(true, { ...MIXED, offersStopAll: true })
})
export const longCommandOpen = defineFixture({
  width: 420,
  render: () => chat(true, { workers: WORKERS, tasks: [LONG_COMMAND] })
})
export const mixedFailedCommandOpen = defineFixture({
  width: 420,
  render: () => chat(true, { workers: [...WORKERS, FAILED_COMMAND], tasks: [COMMAND] })
})
export const mixedNarrow320 = defineFixture({
  width: 320,
  render: () => chat(true, { ...MIXED, offersStopAll: true })
})
export const mixedNarrow320Folded = defineFixture({ width: 320, render: () => chat(false, MIXED) })

const WORKFLOW: AgentSessionBackgroundTask = {
  id: 'fixture-flow-1',
  kind: 'workflow',
  description: 'Example release flow',
  state: 'working',
  startedAt: minutes(6),
  stoppable: true
}
// The safety net: a foreground command still live after its call ended, state unverified.
const UNVERIFIED: AgentSessionBackgroundTask = {
  id: 'fixture-shell-3',
  kind: 'command',
  description: 'npm run build',
  state: 'unverifiable',
  startedAt: minutes(7),
  stoppable: true
}
const failedWorker = (index: number, title: string) =>
  worker(index, `Task ${index}`, title, 'failed', {
    reason: 'Example failure.',
    settlement: `fixture-settled-${index}`,
    stoppable: false
  })

export const unverifiedCommandOpen = defineFixture({
  width: 420,
  render: () => chat(true, { workers: WORKERS, tasks: [COMMAND, UNVERIFIED] })
})
export const workflowOpen = defineFixture({
  width: 420,
  render: () => chat(true, { workers: WORKERS, tasks: [WORKFLOW, COMMAND] })
})
export const clearFailedWorkersOpen = defineFixture({
  width: 420,
  render: () =>
    chat(true, {
      workers: [
        failedWorker(5, 'Rename the example module'),
        failedWorker(6, 'Update the sample docs'),
        { ...FAILED_COMMAND, settlement: null }
      ],
      tasks: [COMMAND]
    })
})
// A failed worker pair, a failed command Clear leaves, and the chat's own Stop all, at 320.
const ACTIONS_CASE = {
  workers: [
    ...WORKERS,
    failedWorker(5, 'Rename the example module'),
    failedWorker(6, 'Update the sample docs'),
    { ...FAILED_COMMAND, settlement: null }
  ],
  tasks: [SUBAGENT, COMMAND],
  offersStopAll: true
}
export const actionsStopClear320 = defineFixture({
  width: 320,
  render: () => chat(true, ACTIONS_CASE)
})
export const actionsStopClear420 = defineFixture({
  width: 420,
  render: () => chat(true, ACTIONS_CASE)
})
// The same without a failed command, so Clear reads just "Clear failed".
const ACTIONS_SHORT_CASE = { ...ACTIONS_CASE, workers: ACTIONS_CASE.workers.slice(0, 4) }
export const actionsStopClearShort320 = defineFixture({
  width: 320,
  render: () => chat(true, ACTIONS_SHORT_CASE)
})
export const actionsStopClearShort420 = defineFixture({
  width: 420,
  render: () => chat(true, ACTIONS_SHORT_CASE)
})
// Wide enough for the chip's label, Clear and Stop side by side in the header.
export const actionsStopClear560 = defineFixture({
  width: 560,
  render: () => chat(true, ACTIONS_CASE)
})
export const actionsStopClearShort560 = defineFixture({
  width: 560,
  render: () => chat(true, ACTIONS_SHORT_CASE)
})
export const workflowStopAllOpen = defineFixture({
  width: 420,
  render: () => chat(true, { workers: WORKERS, tasks: [WORKFLOW, COMMAND], offersStopAll: true })
})

// Over 30 rows, so the card draws only a window of them: 25 workers then 10 background commands.
const MANY_WORKERS = Array.from({ length: 25 }, (_, index) =>
  worker(20 + index, `Task ${index + 1}`, `Example worker task ${index + 1}`)
)
const MANY_COMMANDS: AgentSessionBackgroundTask[] = Array.from({ length: 10 }, (_, index) => ({
  ...COMMAND,
  id: `fixture-shell-many-${index}`,
  description: `npm run example-${index + 1}`
}))
export const manyMixedOpen = defineFixture({
  width: 420,
  render: () => chat(true, { workers: MANY_WORKERS, tasks: MANY_COMMANDS })
})

// Keyboard: focus the last worker row, press ArrowDown; focus must land on the first command row.
async function arrowFromLastWorker(frame: HTMLElement) {
  const workers = frame.querySelector('[role="group"][aria-label="Workers"]')
  const last = [...(workers?.querySelectorAll<HTMLElement>('[data-worker-dock-open]') ?? [])].at(-1)
  if (!last) {
    throw new Error('No worker row')
  }
  last.focus({ focusVisible: true })
  last.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 150))
  const active = document.activeElement
  const commands = frame.querySelector('[role="group"][aria-label="Background commands"]')
  const first = commands?.querySelector<HTMLElement>('[data-worker-dock-open]')
  if (active !== first) {
    throw new Error(
      `ArrowDown from the last worker row focused: ${active?.getAttribute('aria-label')}`
    )
  }
}

export const mixedKeyboard = defineFixture({
  width: 420,
  render: () => chat(true, MIXED),
  interact: arrowFromLastWorker
})
