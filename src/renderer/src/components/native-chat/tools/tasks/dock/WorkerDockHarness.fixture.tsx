import { useEffect, useMemo, useState } from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { useWorkerDockOwnerActions } from './use-worker-dock-owner-actions'
import {
  WorkerDockAcknowledge,
  WorkerDockStop
} from '../../../../../../../shared/orchestration/dock/worker-dock'
import type { AgentSessionBackgroundTask } from '../../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { workerDockFixturePane } from './worker-dock-pane-fixture'
import { NativeChatBackgroundTasksStatus } from '../NativeChatBackgroundTasksStatus'
import type { WorkerDockRowView } from './WorkerDockRow'
import { SOURCE, seed, worker, type Seed } from './worker-dock-seed-fixture'
import { WorkerDockProviderDetailsDialog } from './WorkerDockProviderDetailsDialog'
import { openWorkerDockRow } from './worker-dock-open'
import { Toaster } from '@/components/ui/sonner'

// A live strip for the rendered interaction suite (tests/tools/worker-dock-rendered): it keeps its
// own open state and answers Stop, Clear and Clear all the way the host does, a moment later.
const LOCAL = { kind: 'local' } as const
type WorkerDockHarnessEvent = {
  action: 'remote-stop' | 'stop-all' | 'stop' | 'clear' | 'clear-all' | 'open'
  id: string
}
type HarnessApi = {
  events: WorkerDockHarnessEvent[]
  start: (title: string) => void
  /** Adds a failure that can be cleared, so a second one brings Clear failed into the footer. */
  fail: (title: string) => void
  finish: (id: string) => void
  /** Every detail read asked of the host, by anchor. */
  reads: string[]
  /** Holds detail reads until released; a stale release answers them with nothing new. */
  holdReads: () => void
  releaseReads: (stale: boolean) => void
}
declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window requires declaration merging.
  interface Window {
    __workerDockHarnesses?: HarnessApi[]
  }
}

function Harness({
  count,
  failed,
  remote = false,
  open = false,
  command = false,
  stopAll = false,
  incomplete = false,
  lazy = 0,
  failReads = 0,
  details = false,
  realOpen = false,
  ...options
}: {
  count: number
  failed: number
  remote?: boolean
  open?: boolean
  command?: boolean
  stopAll?: boolean
  /** Running work the provider does not list (the strip then has no rows of its own). */
  incomplete?: boolean
  /** Details arrive late: only the first `lazy` rows (host order) have them; a window loads 300ms
   *  after it is asked. */
  lazy?: number
  /** The first this-many detail reads fail, as a dropped connection would. */
  failReads?: number
  /** Opening a command shows its details dialog, as a chat does. */
  details?: boolean
  /** A row click goes through the real worker open, whose failure toast shows. */
  realOpen?: boolean
} & Seed) {
  const [rows, setRows] = useState(() => seed(count, failed, remote, options))
  const [detailed, setDetailed] = useState(() => new Set(rows.slice(0, lazy).map((row) => row.id)))
  const [shown, setShown] = useState<{ row: WorkerDockRowView; opener: HTMLElement } | null>(null)
  const [failures] = useState(() => ({ left: failReads }))
  const [reads] = useState<{
    log: string[]
    hold: boolean
    waiting: ((stale: boolean) => void)[]
  }>(() => ({ log: [], hold: false, waiting: [] }))
  const loadWindow = async (anchor: string) => {
    reads.log.push(anchor)
    if (reads.hold) {
      if (await new Promise<boolean>((resolve) => reads.waiting.push(resolve))) {
        return
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (failures.left > 0) {
      failures.left--
      throw new Error('fixture read failed')
    }
    const at = rows.findIndex((row) => row.id === anchor)
    setDetailed(
      (current) =>
        new Set([...current, ...rows.slice(Math.max(0, at - 10), at + 20).map((row) => row.id)])
    )
  }
  const [tasks, setTasks] = useState<AgentSessionBackgroundTask[]>(() =>
    command
      ? [{ id: 'shell-fixture', kind: 'command', description: 'Check the build', state: 'working' }]
      : []
  )
  const [expanded, setExpanded] = useState(open)
  const [events] = useState<WorkerDockHarnessEvent[]>(() => [])
  useEffect(() => {
    let next = count
    const api: HarnessApi = {
      events,
      start: (title) => {
        const row = { ...worker(next++, 'running', remote), title }
        setRows((current) => [row, ...current])
      },
      fail: (title) => {
        const row = { ...worker(next++, 'failed', remote), title, changedAt: Date.now() }
        setRows((current) => [row, ...current])
      },
      finish: (id) => setRows((current) => current.filter((row) => row.id !== id)),
      reads: reads.log,
      holdReads: () => {
        reads.hold = true
      },
      releaseReads: (stale) => {
        reads.hold = false
        for (const answer of reads.waiting.splice(0)) {
          answer(stale)
        }
      }
    }
    Object.assign(window, { __workerDockHarness: api })
    // Every mounted harness, in mount order, for scenes with more than one pane.
    const all = (window.__workerDockHarnesses ??= [])
    all.push(api)
    return () => {
      Reflect.deleteProperty(window, '__workerDockHarness')
      all.splice(all.indexOf(api), 1)
    }
  }, [count, events, remote, reads])
  const record = (event: WorkerDockHarnessEvent) => events.push(event)
  const rpc = useLatestHandler(
    async ({ method, params }: Parameters<typeof window.api.runtime.call>[0]) => {
      if (method === 'orchestration.workerDockAcknowledge') {
        const { settlements } = WorkerDockAcknowledge.parse(params)
        const ids = new Set(settlements.map((item) => item.dispatchId))
        record({
          action: ids.size > 1 ? 'clear-all' : 'clear',
          id: settlements.map((item) => item.dispatchId).join(',')
        })
        setRows((current) => current.filter((row) => !ids.has(row.dispatchId)))
      } else if (method === 'orchestration.workerDockStop') {
        const { dispatch } = WorkerDockStop.parse(params)
        const row = rows.find((item) => item.dispatchId === dispatch)
        if (row) {
          record({ action: 'stop', id: row.id })
          setRows((current) => current.filter((item) => item.id !== row.id))
        }
      }
      return { id: 'dock-fixture', ok: true as const, result: {}, _meta: { runtimeId: 'fixture' } }
    }
  )
  useEffect(() => {
    const previous = window.api.runtime.call
    window.api.runtime.call = rpc
    return () => {
      window.api.runtime.call = previous
    }
  }, [rpc])
  const identities = useMemo(
    () => rows.map((row) => ({ ...row, hasModel: Boolean(row.model) })),
    [rows]
  )
  const owner = useWorkerDockOwnerActions(LOCAL, `orca_session_id:${SOURCE}`, identities)
  return (
    <>
      <NativeChatBackgroundTasksStatus
        sessionId={SOURCE}
        tasks={tasks}
        settledTasks={[]}
        supportsTaskStop
        offersStopAll={stopAll}
        incomplete={incomplete}
        stoppingTaskIds={owner.pending}
        stoppingAll={false}
        indicatorActive
        isVisible
        expanded={expanded}
        onExpandedChange={setExpanded}
        onStop={(id) => {
          if (id) {
            record({ action: 'remote-stop', id })
            setTasks((current) => current.filter((task) => task.id !== id))
          } else {
            record({ action: 'stop-all', id: '' })
          }
        }}
        workerRows={
          new Map(rows.filter((row) => !lazy || detailed.has(row.id)).map((row) => [row.id, row]))
        }
        loadWindow={lazy ? loadWindow : undefined}
        onShowProviderDetails={details ? (row, opener) => setShown({ row, opener }) : undefined}
        workerIdentities={identities}
        onOpenWorker={(row) => {
          record({ action: 'open', id: row.id })
          if (realOpen) {
            openWorkerDockRow(row, LOCAL)
          }
        }}
        onWorkerAction={owner.action}
        onClearAll={owner.clearAll}
      />
      {realOpen ? <Toaster toastOptions={{ className: 'font-sans text-sm' }} /> : null}
      {shown ? (
        <WorkerDockProviderDetailsDialog
          row={shown.row}
          opener={shown.opener}
          sessionId={SOURCE}
          target={LOCAL}
          onClose={() => setShown(null)}
        />
      ) : null}
    </>
  )
}

export const twentyOpen720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={20} failed={3} open />)
})
export const twentyFolded720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={20} failed={3} />)
})
export const twentyOpen390 = defineFixture({
  width: 390,
  render: () => workerDockFixturePane(<Harness count={20} failed={3} open />)
})
export const twentyOpen320 = defineFixture({
  width: 320,
  render: () => workerDockFixturePane(<Harness count={20} failed={3} open />)
})
// Monitoring reports work it does not list and no worker rows: the pill still offers Stop all.
export const unlistedOpen720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={0} failed={0} incomplete stopAll open />)
})
// 100 workers whose details arrive late, so far rows draw as loading first.
export const lazyHundredOpen720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={100} failed={0} lazy={50} open />)
})
// The only worker has failed.
export const lastFailedDetails720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={1} failed={1} open />)
})
// Failed rows with long titles, to check the row wraps cleanly at narrow widths.
function failedRow(width: number) {
  return defineFixture({
    width,
    render: () => workerDockFixturePane(<Harness count={3} failed={2} long open />)
  })
}
export const failedLong720 = failedRow(720)
export const failedLong320 = failedRow(320)
// A failed row whose worker can't be opened here: the click shows the open-failure toast.
export const failedOpenToast720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={1} failed={1} realOpen open />)
})
// The first two detail reads fail; a later key press recovers the last row.
export const lazyFailingOpen720 = defineFixture({
  width: 720,
  render: () =>
    workerDockFixturePane(<Harness count={100} failed={0} lazy={50} failReads={2} open />)
})
// The host's first 50 are newer queued workers; the two older running ones lead the card unloaded.
export const reorderOpen720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={51} failed={0} reorder lazy={50} open />)
})
// Two chat panes side by side, each with a command whose details open in a dialog.
export const twoPanesCommand720 = defineFixture({
  width: 720,
  render: () => (
    <div className="flex gap-2">
      {[0, 1].map((pane) => (
        <div key={pane} data-fixture-pane={pane} className="min-w-0 flex-1">
          {workerDockFixturePane(<Harness count={2} failed={1} command details open />)}
        </div>
      ))}
    </div>
  )
})
export const oneFolded720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={1} failed={0} />)
})
export const threeFolded720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={3} failed={0} variety />)
})
export const threeOpen720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={3} failed={1} variety open />)
})
export const askOpen720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={6} failed={2} ask variety open />)
})
export const askFolded720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={6} failed={2} ask variety />)
})
export const stopAllOpen720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={5} failed={2} stopAll open />)
})
export const longFolded300 = defineFixture({
  width: 300,
  render: () => workerDockFixturePane(<Harness count={3} failed={0} long />)
})
export const longOpen300 = defineFixture({
  width: 300,
  render: () => workerDockFixturePane(<Harness count={20} failed={3} long open />)
})
// Scrolled up from the end, so Jump to latest shows and stacks above the pill.
export const jumpFolded720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={3} failed={1} />),
  interact: async (frame) => {
    const transcript = frame.querySelector<HTMLElement>('[data-fixture-transcript]')
    if (transcript) {
      transcript.scrollTop = 0
      transcript.dispatchEvent(new Event('scroll'))
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})

export const jumpFolded300 = defineFixture({
  width: 300,
  render: () => workerDockFixturePane(<Harness count={3} failed={1} />),
  interact: async (frame) => {
    const transcript = frame.querySelector<HTMLElement>('[data-fixture-transcript]')
    if (transcript) {
      transcript.scrollTop = 0
      transcript.dispatchEvent(new Event('scroll'))
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
export const oneOpen720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={1} failed={0} open />)
})
export const fourOpen720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={4} failed={1} open />)
})
export const remoteOpen720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={6} failed={2} remote open />)
})

export const remoteCommand720 = defineFixture({
  width: 720,
  render: () => workerDockFixturePane(<Harness count={6} failed={2} remote open command />)
})

function stack(width: number, sections: 'question' | 'queue' | 'both') {
  return defineFixture({
    width,
    render: () => workerDockFixturePane(<Harness count={9} failed={2} command />, sections)
  })
}

export const question720 = stack(720, 'question')
export const question390 = stack(390, 'question')
export const question320 = stack(320, 'question')
export const queue720 = stack(720, 'queue')
export const queue390 = stack(390, 'queue')
export const queue320 = stack(320, 'queue')
export const both720 = stack(720, 'both')
export const both390 = stack(390, 'both')
export const both320 = stack(320, 'both')
