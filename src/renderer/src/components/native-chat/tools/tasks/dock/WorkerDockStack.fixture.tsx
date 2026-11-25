import { useRef } from 'react'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { NativeChatThreadGoalBanner } from '../../../session/goals/NativeChatThreadGoalBanner'
import { NativeChatFindBar } from '../../../viewport/find/NativeChatFindBar'
import { NativeChatBackgroundTasksStatus } from '../NativeChatBackgroundTasksStatus'
import { workerDockFixturePane } from './worker-dock-pane-fixture'
import type { WorkerDockRowView } from './WorkerDockRow'

// Dev-only: the worker chip and panel in the chat's whole stack above the message box.
const SOURCE = 'fixture-stack'
const minutes = (count: number) => Date.now() - count * 60_000
const titles = [
  'GitHub sidebar feedback research across the open issues and the last two releases',
  'Fix app rail spacing',
  'Review PR #47379 and summarize what still blocks it'
]
const running: WorkerDockRowView[] = titles.map((title, index) => ({
  kind: 'worker',
  id: `stack:${index}`,
  dispatchId: `ctx_stack_${index}`,
  source: SOURCE,
  name: 'claude',
  title,
  model: ['gpt-6.1-terra', 'claude-opus-5-5', 'gpt-6-astra'][index],
  state: 'running',
  changedAt: minutes(3 + index * 2),
  startedAt: minutes(3 + index * 2),
  reason: null,
  settlement: null,
  resultId: null,
  stoppable: true,
  ownerActionsAvailable: true
}))

const fail = (row: WorkerDockRowView, index: number): WorkerDockRowView => ({
  ...row,
  id: `stack:failed:${index}`,
  dispatchId: `ctx_stack_failed_${index}`,
  state: 'failed',
  reason: 'Typecheck failed',
  settlement: `settled:${index}`,
  resultId: `result:${index}`,
  stoppable: false
})
const failedOnly = running.slice(0, 2).map(fail)
const mixed = [...running, ...failedOnly]
const many = Array.from({ length: 20 }, (_, index) => {
  const row = { ...running[index % 3], id: `stack:${index}`, dispatchId: `ctx_stack_${index}` }
  return index < 3 ? fail(row, index) : row
})

function Tray({ open, rows }: { open: boolean; rows: readonly WorkerDockRowView[] }) {
  return (
    <NativeChatBackgroundTasksStatus
      sessionId={SOURCE}
      tasks={[]}
      settledTasks={[]}
      supportsTaskStop
      offersStopAll
      stoppingTaskIds={new Set()}
      stoppingAll={false}
      indicatorActive
      isVisible
      expanded={open}
      onExpandedChange={() => {}}
      onStop={() => {}}
      workerRows={new Map(rows.map((row) => [row.id, row]))}
      workerIdentities={rows}
      onWorkerAction={() => {}}
    />
  )
}

const goal = (
  <NativeChatThreadGoalBanner
    goal={{
      objective: 'Ship the worker tray redesign with screenshots on the PR',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 240,
      createdAt: 0,
      updatedAt: 0,
      checks: 0
    }}
    pending={false}
    hostChanges={false}
    sendUnavailable={false}
    isVisible={false}
    runningTurn={null}
    onChange={() => {}}
  />
)

function FindBar() {
  const rootRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <NativeChatFindBar
      isVisible
      find={{
        isOpen: true,
        query: 'worker',
        setQuery: () => {},
        close: () => {},
        open: undefined,
        onKeyDownCapture: () => {},
        rootRef,
        barRef,
        inputRef,
        revealMatch: () => {}
      }}
    />
  )
}

// Scrolled up, so Jump to latest shows above the chip or the open panel.
const scrollAway = async () => {
  document.querySelector<HTMLElement>('[data-fixture-transcript]')?.scrollTo({ top: 0 })
  await new Promise((resolve) => setTimeout(resolve, 300))
}

function stack(width: number, open: boolean, prompt = false, rows = running) {
  return defineFixture({
    width,
    render: () =>
      workerDockFixturePane(<Tray open={open} rows={rows} />, prompt ? 'both' : 'queue', {
        goal,
        find: <FindBar />,
        queued: 2,
        promptReplacesComposer: true
      }),
    interact: scrollAway
  })
}

export const folded320 = stack(320, false)
export const open320 = stack(320, true)
export const promptFolded320 = stack(320, false, true)
export const promptOpen320 = stack(320, true, true)
export const folded720 = stack(720, false)
export const open720 = stack(720, true)
export const open1000 = stack(1000, true)
export const failedFolded320 = stack(320, false, false, failedOnly)
export const failedOpen320 = stack(320, true, false, failedOnly)
export const mixedFolded320 = stack(320, false, false, mixed)
export const mixedOpen320 = stack(320, true, false, mixed)
export const manyFolded390 = stack(390, false, false, many)
export const manyOpen390 = stack(390, true, false, many)
