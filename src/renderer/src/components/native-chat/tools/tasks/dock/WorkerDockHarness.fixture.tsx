import { useEffect, useState } from 'react'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../../../appearance/native-chat-appearance-style'
import { NativeChatBackgroundTasksStatus } from '../NativeChatBackgroundTasksStatus'
import { NativeChatWorkerDockFrame } from './NativeChatWorkerDockFrame'
import type { WorkerDockRowView } from './WorkerDockRow'

// A live strip for the rendered interaction suite (tests/tools/worker-dock-rendered): it keeps its
// own open state and answers Stop, Clear and Clear all the way the host does, a moment later.
const SOURCE = '6c3f8e4a-ad5b-4a9c-9e37-2f4d8a0b3c59'
const TITLES = [
  'Fix streaming journal amplification',
  'Fix repeated worktree catalog scans',
  'Cache the branch list per repository',
  'Drop the duplicate status poll',
  'Batch the sidebar badge writes',
  'Stream the diff instead of buffering it',
  'Reuse the parsed config between tabs',
  'Coalesce terminal resize events',
  'Skip hidden pane layout passes',
  'Index session history by worktree',
  'Defer the plugin manifest scan',
  'Trim the startup font preload',
  'Share one watcher per repository',
  'Avoid re-sorting the unchanged roster',
  'Split the dock read model',
  'Bound the activity refresh',
  'Drop the second layout read',
  'Keep the composer height stable',
  'Collapse duplicate wakes',
  'Name the answering turn'
]

export type WorkerDockHarnessEvent = { action: 'stop' | 'clear' | 'clear-all' | 'open'; id: string }
type HarnessApi = {
  events: WorkerDockHarnessEvent[]
  start: (title: string) => void
  finish: (id: string) => void
}
const harnessWindow = window as Window & { __workerDockHarness?: HarnessApi }

function worker(index: number, state: WorkerDockRowView['state'], remote: boolean) {
  const at = Date.now() - (index + 2) * 60_000
  const failed = state === 'failed' || state === 'unexpected'
  return {
    kind: 'worker',
    id: `dock:${index}`,
    dispatchId: `ctx_fixture_${index}`,
    source: SOURCE,
    name: `ORCA-${30 + index}`,
    title: TITLES[index % TITLES.length],
    model: 'gpt-6.1-sol',
    state,
    changedAt: at,
    startedAt: at,
    reason: failed ? 'Typecheck failed: 3 errors in worker-dock-read.ts' : null,
    settlement: failed ? `settled:ctx_fixture_${index}` : null,
    resultId: failed ? `result:ctx_fixture_${index}` : null,
    stoppable: state === 'running',
    ownerActionsAvailable: !remote
  } satisfies WorkerDockRowView
}

function seed(count: number, failed: number, remote: boolean): WorkerDockRowView[] {
  return Array.from({ length: count }, (_, index) =>
    worker(index, index < failed ? 'failed' : 'running', remote)
  )
}

function Harness({
  count,
  failed,
  remote = false,
  open = false
}: {
  count: number
  failed: number
  remote?: boolean
  open?: boolean
}) {
  const [rows, setRows] = useState(() => seed(count, failed, remote))
  const [expanded, setExpanded] = useState(open)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const events: WorkerDockHarnessEvent[] = []
    let next = count
    harnessWindow.__workerDockHarness = {
      events,
      start: (title) =>
        setRows((current) => [{ ...worker(next++, 'running', remote), title }, ...current]),
      finish: (id) => setRows((current) => current.filter((row) => row.id !== id))
    }
    return () => {
      delete harnessWindow.__workerDockHarness
    }
  }, [count, remote])
  // The host answers after a round trip: the row leaves the snapshot, as an acknowledgment does.
  const settle = (ids: readonly string[]) => {
    setPending((current) => new Set([...current, ...ids]))
    setTimeout(() => {
      setRows((current) => current.filter((row) => !ids.includes(row.id)))
      setPending((current) => new Set([...current].filter((id) => !ids.includes(id))))
    }, 60)
  }
  const record = (event: WorkerDockHarnessEvent) =>
    harnessWindow.__workerDockHarness?.events.push(event)
  return (
    <NativeChatBackgroundTasksStatus
      sessionId={SOURCE}
      tasks={[]}
      settledTasks={[]}
      supportsTaskStop
      offersStopAll={false}
      stoppingTaskIds={pending}
      stoppingAll={false}
      indicatorActive
      isVisible
      expanded={expanded}
      onExpandedChange={setExpanded}
      onStop={() => {}}
      workerRows={new Map(rows.map((row) => [row.id, row]))}
      workerIdentities={rows.map(({ id, state, changedAt, settlement, ownerActionsAvailable }) => ({
        id,
        state,
        changedAt,
        settlement,
        ownerActionsAvailable
      }))}
      onOpenWorker={(row) => record({ action: 'open', id: row.id })}
      onWorkerAction={(row, action) => {
        record({ action, id: row.id })
        settle([row.id])
      }}
      onClearAll={() => {
        const ids = rows
          .filter((row) => row.state === 'failed' || row.state === 'unexpected')
          .map((row) => row.id)
        record({ action: 'clear-all', id: ids.join(',') })
        settle(ids)
      }}
    />
  )
}

/** The strip in a full-height chat pane above a message box, as a chat shows it. */
function chatPane(strip: React.ReactNode) {
  return (
    <div
      data-native-chat-root=""
      className="native-chat-appearance flex h-[calc(100vh-2rem)] flex-col bg-chat-canvas"
      style={nativeChatAppearanceStyle({})}
    >
      <div
        data-fixture-transcript=""
        className="scrollbar-sleek min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm text-chat-foreground"
      >
        {Array.from({ length: 30 }, (_, index) => (
          <p key={index}>Transcript line {index + 1}: the coordinator reports on its workers.</p>
        ))}
      </div>
      <div className="shrink-0 px-3 pt-2 pb-4">
        <div className="rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs">
          <NativeChatWorkerDockFrame>{strip}</NativeChatWorkerDockFrame>
          <textarea
            data-fixture-composer=""
            aria-label="Message"
            className="block min-h-12 w-full resize-none bg-transparent px-2 py-2 text-sm text-chat-foreground outline-none"
            defaultValue=""
            placeholder="Ask anything, / for commands, @ for context"
          />
        </div>
      </div>
    </div>
  )
}

export const twentyOpen720 = defineFixture({
  width: 720,
  render: () => chatPane(<Harness count={20} failed={3} open />)
})
export const twentyFolded720 = defineFixture({
  width: 720,
  render: () => chatPane(<Harness count={20} failed={3} />)
})
export const twentyOpen390 = defineFixture({
  width: 390,
  render: () => chatPane(<Harness count={20} failed={3} open />)
})
export const twentyOpen320 = defineFixture({
  width: 320,
  render: () => chatPane(<Harness count={20} failed={3} open />)
})
export const oneOpen720 = defineFixture({
  width: 720,
  render: () => chatPane(<Harness count={1} failed={0} open />)
})
export const fourOpen720 = defineFixture({
  width: 720,
  render: () => chatPane(<Harness count={4} failed={1} open />)
})
export const remoteOpen720 = defineFixture({
  width: 720,
  render: () => chatPane(<Harness count={6} failed={2} remote open />)
})
