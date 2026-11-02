import { defineFixture } from '../../component-fixtures/component-fixture'
import type {
  OrchestrationCrewRow,
  OrchestrationCrewSnapshot
} from '../../../../shared/orchestration-crew'
import { CrewPanelContent } from './OrchestrationCrewPanel'

const snapshot = (name: string): OrchestrationCrewSnapshot => ({
  status: 'ok',
  sections: {
    managedBy: [],
    talkingWith: [],
    managing: [
      {
        partyKey: name,
        role: 'worker',
        label: name,
        agentKind: 'codex',
        status: 'working',
        sendAddress: `term_${name}`,
        task: { title: 'Review the result', state: 'active' }
      }
    ]
  }
})

// Orca-specific Crew overlay: actual menu/pane owner with controlled content and clipboard IO.
export const keyboardPanes = defineFixture({
  width: 760,
  setup: () => {
    window.api.ui.writeTerminalClipboardText = async () => {}
  },
  render: () => (
    <div className="grid h-96 grid-cols-2 gap-2">
      <div className="pane relative overflow-hidden" data-testid="crew-pane-a">
        <label>
          Terminal destination A
          <input aria-label="Terminal destination A" />
        </label>
        <CrewPanelContent
          target={{ kind: 'local' }}
          party="term_a"
          canMention={false}
          mention={() => {}}
          snapshot={snapshot('Alpha')}
        />
      </div>
      <div data-native-chat-root className="relative overflow-hidden" data-testid="crew-pane-b">
        <label>
          Native destination B
          <input aria-label="Native destination B" />
        </label>
        <CrewPanelContent
          target={{ kind: 'local' }}
          party="term_b"
          canMention={false}
          mention={() => {}}
          snapshot={snapshot('Beta')}
        />
      </div>
    </div>
  )
})

type Agent = {
  name: string
  agent: string
  status: string
  task?: string
  taskState?: string
  message?: string
  question?: string
  minutesAgo: number
}

// Fixture times are relative to load so the "15h ago" labels read as written.
function row(
  role: OrchestrationCrewRow['role'],
  agent: Agent,
  index: number
): OrchestrationCrewRow {
  const at = new Date(Date.now() - agent.minutesAgo * 60_000).toISOString()
  return {
    partyKey: `${role}-${index}`,
    role,
    label: agent.name,
    agentKind: agent.agent,
    status: agent.status,
    sendAddress: `term_${role}_${index}`,
    ...(agent.task ? { task: { title: agent.task, state: agent.taskState ?? 'active' } } : {}),
    ...(agent.message
      ? {
          latest: {
            direction: 'from' as const,
            preview: agent.message,
            at,
            sequence: 10_000 - agent.minutesAgo
          }
        }
      : {}),
    ...(agent.question ? { pendingQuestion: { preview: agent.question, at } } : {})
  }
}

const WORKERS: Agent[] = [
  {
    name: 'worker-task_a1',
    agent: 'claude',
    status: 'waiting',
    task: 'Draft release notes for 1.4 from the merged pull requests and the changelog',
    message: 'Collected 38 merged pull requests',
    question: 'Include the two reverted pull requests in the notes?',
    minutesAgo: 1
  },
  {
    name: 'worker-task_b2',
    agent: 'codex',
    status: 'working',
    task: 'Read README.md and report what the repo is for',
    message: 'Reading README.md and the docs folder',
    minutesAgo: 2
  },
  {
    name: 'worker-task_c3',
    agent: 'codex',
    status: 'blocked',
    task: 'Write contract tests for the sessions API',
    message: 'Drafted four cases',
    question: 'Should the tests hit the real database?',
    minutesAgo: 4
  },
  {
    name: 'release-notes',
    agent: 'claude',
    status: 'working',
    message: 'Adjusted padding on the generated tables',
    minutesAgo: 9
  },
  {
    name: 'worker-task_e5',
    agent: 'gemini',
    status: 'working',
    task: 'Update the CLI reference for the new flags',
    message: 'Updated 6 of 9 flag sections',
    minutesAgo: 11
  },
  {
    name: 'worker-task_f6',
    agent: 'claude',
    status: 'done',
    task: 'Add the sessions table and its backfill',
    message: 'Done: table added, backfill tested on a copy',
    minutesAgo: 47
  },
  {
    name: 'worker-task_g7',
    agent: 'opencode',
    status: 'working',
    task: 'Find why the observer test times out on cold runners',
    message: 'Timing each mode separately',
    minutesAgo: 70
  },
  {
    name: 'worker-task_h8',
    agent: 'codex',
    status: 'done',
    task: 'Remove unused exports flagged by the linter',
    message: 'Removed 14 exports; tests pass',
    minutesAgo: 180
  },
  {
    name: 'worker-task_i9',
    agent: 'claude',
    status: 'done',
    task: 'Fix long-path failures in the Windows build',
    taskState: 'failed',
    message: 'Build failed: path too long in the packaging step',
    minutesAgo: 900
  },
  {
    name: 'worker-task_j10',
    agent: 'pi',
    status: 'unknown',
    task: 'Check the docs links',
    minutesAgo: 2000
  }
]

const MANAGER: Agent = {
  name: 'Coordinator',
  agent: 'claude',
  status: 'working',
  task: 'Plan the sessions migration',
  message: 'Assigned the backfill script to you',
  minutesAgo: 6
}

const PEER: Agent = {
  name: 'Reviewer',
  agent: 'codex',
  status: 'done',
  task: 'Fix long-path failures in the Windows build',
  taskState: 'failed',
  message: 'Build failed: path too long in the packaging step',
  minutesAgo: 120
}

function crew(managedBy: Agent[], managing: Agent[], talkingWith: Agent[]) {
  return {
    status: 'ok' as const,
    sections: {
      managedBy: managedBy.map((agent, index) => row('manager', agent, index)),
      managing: managing.map((agent, index) => row('worker', agent, index)),
      talkingWith: talkingWith.map((agent, index) => row('peer', agent, index))
    }
  }
}

// A chat-sized pane with placeholder lines, so any chat showing above the panel is visible.
function pane(value: OrchestrationCrewSnapshot) {
  return defineFixture({
    width: 900,
    render: () => (
      <div className="pane relative h-130 overflow-hidden rounded-md border border-border bg-background p-4">
        <div className="grid max-w-md gap-3 pt-6">
          {Array.from({ length: 14 }, (_, index) => (
            <div
              key={index}
              className="h-2 rounded bg-muted"
              style={{ width: `${90 - index * 4}%` }}
            />
          ))}
        </div>
        <CrewPanelContent
          target={{ kind: 'local' }}
          party="term_self"
          canMention
          mention={() => {}}
          snapshot={value}
        />
      </div>
    )
  })
}

// A wide native chat: the panel overlays the transcript and ends above the composer.
function nativeChat(value: OrchestrationCrewSnapshot) {
  return defineFixture({
    width: 1100,
    render: () => (
      <div className="flex h-130 flex-col overflow-hidden rounded-md border border-border bg-background">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <CrewPanelContent
            target={{ kind: 'local' }}
            party="term_self"
            snapshot={value}
            canMention
            mention={() => {}}
          />
          <div className="mx-auto grid w-full max-w-3xl gap-3 px-4 pt-10">
            {Array.from({ length: 12 }, (_, index) => (
              <div
                key={index}
                className="h-2 rounded bg-muted"
                style={{ width: `${96 - index * 3}%` }}
              />
            ))}
          </div>
        </div>
        <div className="mx-auto mb-3 flex h-20 w-full max-w-3xl items-end justify-end rounded-lg border border-border p-2">
          <span data-testid="composer-send" className="size-7 rounded-full bg-foreground" />
        </div>
      </div>
    )
  })
}

function expanded(value: OrchestrationCrewSnapshot, host = pane) {
  return {
    ...host(value),
    interact: (frame: HTMLElement) =>
      frame.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
  }
}

const twoWorkers = crew([], [WORKERS[1], WORKERS[5]], [])
const fiveWorkers = crew([], [WORKERS[1], WORKERS[2], WORKERS[4], WORKERS[5], WORKERS[8]], [])
const tenWorkers = crew([], WORKERS, [])
const managerAndThree = crew([MANAGER], [WORKERS[2], WORKERS[4], WORKERS[5]], [])
const managedByOnly = crew([MANAGER], [], [])
const peerOnly = crew([], [], [PEER])
// Mention all is dimmed once no worker still runs.
const allFinished = crew([], [WORKERS[5], WORKERS[7]], [])

export const twoWorkersCollapsed = pane(twoWorkers)
export const twoWorkersExpanded = expanded(twoWorkers)
export const fiveWorkersCollapsed = pane(fiveWorkers)
export const fiveWorkersExpanded = expanded(fiveWorkers)
export const tenWorkersCollapsed = pane(tenWorkers)
export const tenWorkersExpanded = expanded(tenWorkers)
export const managerAndThreeWorkersCollapsed = pane(managerAndThree)
export const managerAndThreeWorkersExpanded = expanded(managerAndThree)
export const managedByOnlyCollapsed = pane(managedByOnly)
export const managedByOnlyExpanded = expanded(managedByOnly)
export const peerOnlyCollapsed = pane(peerOnly)
export const peerOnlyExpanded = expanded(peerOnly)
export const allFinishedExpanded = expanded(allFinished)
export const nativeChatCollapsed = nativeChat(fiveWorkers)
export const nativeChatExpanded = expanded(fiveWorkers, nativeChat)
