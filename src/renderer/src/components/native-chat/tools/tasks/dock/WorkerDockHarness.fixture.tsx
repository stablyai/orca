import { useEffect, useMemo, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { useWorkerDockOwnerActions } from './use-worker-dock-owner-actions'
import {
  WorkerDockAcknowledge,
  WorkerDockStop
} from '../../../../../../../shared/orchestration/dock/worker-dock'
import { NativeChatDock } from '../../../pane/dock/NativeChatDock'
import { NativeChatQuestionCard } from '../../../prompts/NativeChatQuestionCard'
import { NativeChatQueuedMessageList } from '../../../queue/NativeChatQueuedMessageList'
import type { StructuredAgentSessionQueuedMessagesController } from '../../../queue/use-structured-agent-session-queued-messages'
import type { AgentSessionBackgroundTask } from '../../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../../../appearance/native-chat-appearance-style'
import { NativeChatBackgroundTasksStatus } from '../NativeChatBackgroundTasksStatus'
import { NativeChatWorkerDockFrame } from './NativeChatWorkerDockFrame'
import type { WorkerDockRowView } from './WorkerDockRow'

// A live strip for the rendered interaction suite (tests/tools/worker-dock-rendered): it keeps its
// own open state and answers Stop, Clear and Clear all the way the host does, a moment later.
const LOCAL = { kind: 'local' } as const
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

type WorkerDockHarnessEvent = {
  action: 'remote-stop' | 'stop' | 'clear' | 'clear-all' | 'open' | 'restore'
  id: string
}
type HarnessApi = {
  events: WorkerDockHarnessEvent[]
  start: (title: string) => void
  finish: (id: string) => void
}
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
  open = false,
  command = false
}: {
  count: number
  failed: number
  remote?: boolean
  open?: boolean
  command?: boolean
}) {
  const [rows, setRows] = useState(() => seed(count, failed, remote))
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
      finish: (id) => setRows((current) => current.filter((row) => row.id !== id))
    }
    Object.assign(window, { __workerDockHarness: api })
    return () => {
      Reflect.deleteProperty(window, '__workerDockHarness')
    }
  }, [count, events, remote])
  const [cleared] = useState(() => new Map<string, WorkerDockRowView>())
  const record = (event: WorkerDockHarnessEvent) => events.push(event)
  const rpc = useLatestHandler(
    async ({ method, params }: Parameters<typeof window.api.runtime.call>[0]) => {
      if (method === 'orchestration.workerDockAcknowledge') {
        const { settlements, acknowledged } = WorkerDockAcknowledge.parse(params)
        const ids = new Set(settlements.map((item) => item.dispatchId))
        record({
          action: acknowledged ? (ids.size > 1 ? 'clear-all' : 'clear') : 'restore',
          id: settlements.map((item) => item.dispatchId).join(',')
        })
        if (acknowledged) {
          for (const row of rows) {
            if (ids.has(row.dispatchId)) {
              cleared.set(row.dispatchId, row)
            }
          }
          setRows((current) => current.filter((row) => !ids.has(row.dispatchId)))
        } else {
          const restored = [...ids].flatMap((id) => cleared.get(id) ?? [])
          setRows((current) => [...restored, ...current])
        }
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
  const owner = useWorkerDockOwnerActions(LOCAL, `orca_session_id:${SOURCE}`, identities, (row) =>
    record({ action: 'open', id: row.id })
  )
  return (
    <NativeChatBackgroundTasksStatus
      sessionId={SOURCE}
      tasks={tasks}
      settledTasks={[]}
      supportsTaskStop
      offersStopAll={false}
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
        }
      }}
      workerRows={new Map(rows.map((row) => [row.id, row]))}
      workerIdentities={identities}
      onOpenWorker={owner.open}
      onWorkerAction={owner.action}
      onClearAll={owner.clearAll}
    />
  )
}

/** The strip in a full-height chat pane above a message box, as a chat shows it. */
const queue: StructuredAgentSessionQueuedMessagesController = {
  cards: [
    {
      messageId: 'fixture-queued',
      position: 0,
      state: 'waiting',
      hold: 'turn',
      text: 'Check the release notes.'
    }
  ],
  queueCapable: true,
  clearCapable: true,
  pause: null,
  resume: async () => true,
  clear: async () => true,
  queuePending: null,
  pending: () => null,
  steer: async () => {},
  remove: async () => {},
  editCapable: false,
  editor: undefined,
  edit: async () => {},
  steerHead: undefined,
  isWorking: true
}

function chatPane(strip: React.ReactNode, sections?: 'question' | 'queue' | 'both') {
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
      <Toaster />
      <NativeChatDock>
        <NativeChatWorkerDockFrame>{strip}</NativeChatWorkerDockFrame>
        {sections === 'question' || sections === 'both' ? (
          <NativeChatQuestionCard
            prompt={{
              questions: [
                {
                  header: 'Release notes',
                  question: 'Which change should the release notes lead with?',
                  multiSelect: false,
                  options: [
                    {
                      label: 'Worker reliability',
                      description: 'Show the active work and recent failures.'
                    },
                    {
                      label: 'Composer layout',
                      description: 'Highlight changes to the message box.'
                    }
                  ]
                }
              ]
            }}
            onAnswer={() => {}}
            onCancel={() => {}}
          />
        ) : null}
        {sections === 'queue' || sections === 'both' ? (
          <NativeChatQueuedMessageList controller={queue} chatWorktreeId={null} />
        ) : null}
        <div className="shrink-0 px-3 pt-2 pb-4 sm:px-4">
          <div className="rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs">
            <textarea
              data-fixture-composer=""
              aria-label="Message"
              className="block min-h-12 w-full resize-none bg-transparent px-2 py-2 text-sm text-chat-foreground outline-none"
              defaultValue=""
              placeholder="Ask anything, / for commands, @ for context"
            />
          </div>
        </div>
      </NativeChatDock>
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

export const remoteCommand720 = defineFixture({
  width: 720,
  render: () => chatPane(<Harness count={6} failed={2} remote open command />)
})

function stack(width: number, sections: 'question' | 'queue' | 'both') {
  return defineFixture({
    width,
    render: () => chatPane(<Harness count={9} failed={2} command />, sections)
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
