import { useState } from 'react'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import type { WorkerDockElsewhereEntry } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { NativeChatBackgroundTasksStatus } from '../NativeChatBackgroundTasksStatus'
import { workerDockFixturePane } from './worker-dock-pane-fixture'
import { RealComposer, running } from './worker-dock-stack-fixture'
import type { WorkerDockRowView } from './WorkerDockRow'

// Dev-only: a chat's island with the work running in chats it handed work to by mail ("Other
// chats"), at the narrowest pane, folded and open, with and without its own workers.
const SOURCE = '6c3f8e4a-ad5b-4a9c-9e37-2f4d8a0b3c59'
const chat = (source: string, running: number, title?: string): WorkerDockElsewhereEntry => ({
  source,
  sessionId: source,
  workspaceId: 'fixture-workspace',
  running,
  ...(title ? { title } : {})
})
const scan = chat('chat-scan', 25, 'Hourly release readiness scan run 94 for prod 1.4.279')
const five = [
  scan,
  chat('chat-docs', 6, 'Docs sweep'),
  chat('chat-i18n', 3, 'Nightly i18n check'),
  chat('chat-perf', 2, 'Perf triage'),
  chat('chat-untitled', 1)
]

function Tray({
  open,
  rows,
  elsewhere
}: {
  open: boolean
  rows: readonly WorkerDockRowView[]
  elsewhere: readonly WorkerDockElsewhereEntry[]
}) {
  const [expanded, setExpanded] = useState(open)
  return (
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
      onExpandedChange={setExpanded}
      onStop={() => {}}
      workerRows={new Map(rows.map((row) => [row.id, row]))}
      workerIdentities={rows}
      onWorkerAction={() => {}}
      elsewhere={elsewhere}
      onOpenElsewhere={() => {}}
    />
  )
}

// Keyboard focus on a row, as an arrow key from the open chip leaves it.
const focusRow = (selector: string) => async (frame: HTMLElement) => {
  frame.querySelector<HTMLElement>(`${selector} [data-worker-dock-open]`)?.focus()
  await new Promise((resolve) => setTimeout(resolve, 300))
}

function pane(
  width: number,
  open: boolean,
  rows: readonly WorkerDockRowView[],
  elsewhere: readonly WorkerDockElsewhereEntry[],
  interact?: (frame: HTMLElement) => Promise<void>
) {
  return defineFixture({
    width,
    render: () =>
      workerDockFixturePane(<Tray open={open} rows={rows} elsewhere={elsewhere} />, undefined, {
        composer: <RealComposer />
      }),
    ...(interact ? { interact } : {})
  })
}

/** A: no worker of its own, folded: "25 elsewhere". */
export const elsewhereOnlyFolded320 = pane(320, false, [], [scan])
/** B: two of its own, folded: "2 running · +25". */
export const ownAndElsewhereFolded320 = pane(320, false, running.slice(0, 2), [scan])
/** C: no worker of its own, open, a long chat name, keyboard focus on its row. */
export const elsewhereOnlyOpen320 = pane(
  320,
  true,
  [],
  [scan],
  focusRow('[data-worker-dock-row^="elsewhere:"]')
)
/** D: two of its own (the first focused, so its Stop shows) and one other chat, open. */
export const ownAndElsewhereOpen320 = pane(
  320,
  true,
  running.slice(0, 2),
  [scan],
  focusRow(`[data-worker-dock-row="${running[0]!.id}"]`)
)
/** E: five other chats: three rows and "+2 more chats"; the last one unnamed. */
export const fiveChatsOpen320 = pane(320, true, [], five)
/** Four other chats show whole. */
export const fourChatsOpen320 = pane(320, true, [], five.slice(1))
export const ownAndElsewhereOpen720 = pane(720, true, running.slice(0, 2), [scan])
