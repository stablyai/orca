import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'
import { NativeChatCrewBackgroundTasksStatus } from './NativeChatCrewBackgroundTasksStatus'
import type { AgentSessionBackgroundTask } from '../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import {
  crewSummary,
  type OrchestrationCrewRow,
  type OrchestrationCrewSnapshot
} from '../../../../../../shared/orchestration/orchestration-crew'
import type { NativeChatCrew } from '../../../orchestration-crew/use-native-chat-crew'
import { UNKNOWN_CREW_STATE } from '../../../orchestration-crew/orchestration-crew-subscription'

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function row(
  partyKey: string,
  label: string,
  agentKind: string,
  status: string,
  extra: Partial<OrchestrationCrewRow> = {}
): OrchestrationCrewRow {
  return {
    partyKey,
    role: 'worker',
    label,
    agentKind,
    status,
    sendAddress: `term_${partyKey}`,
    // As the read model does: a worker's own newest message is also its reply.
    reply: extra.latest?.direction === 'from' ? extra.latest : undefined,
    ...extra
  }
}

const workers: OrchestrationCrewRow[] = [
  row('w1', 'auth-tests', 'codex', 'working', {
    task: { title: 'Rewrite auth integration tests', state: 'dispatched' },
    // A question to the coordinator is also the worker's latest message.
    pendingQuestion: {
      preview: 'Should the session fixture keep the legacy cookie, or drop it with the migration?',
      at: ago(1)
    },
    latest: {
      direction: 'from',
      preview: 'Should the session fixture keep the legacy cookie, or drop it with the migration?',
      at: ago(1),
      sequence: 5
    }
  }),
  row('w2', 'migrate-db', 'claude', 'working', {
    task: { title: 'Migrate sessions table to token store', state: 'dispatched' },
    latest: {
      direction: 'from',
      preview: 'Migration written; running it against the fixture DB now.',
      at: ago(3),
      sequence: 2
    }
  }),
  row('w3', 'perf-audit', 'antigravity', 'waiting', {
    task: { title: 'Profile token refresh under load', state: 'dispatched' },
    approvals: [
      {
        at: ago(2),
        approval: {
          v: 1,
          approvalId: 'apr_1',
          state: 'open',
          worker: { handle: 'term_w3', dispatchId: 'ctx_1', taskId: 'task_1' },
          summary: { title: 'Run pnpm bench --filter auth', detail: null, reason: null },
          allowedActions: ['allow', 'deny']
        }
      }
    ]
  }),
  row('w4', 'docs-pass', 'claude', 'done', {
    task: { title: 'Update auth docs', state: 'completed' },
    latest: {
      direction: 'from',
      preview: 'Done: docs/auth.md and the migration guide are updated. PR #4412.',
      at: ago(12),
      sequence: 1
    }
  })
]

const coordinatorRows: OrchestrationCrewSnapshot = {
  status: 'ok',
  sections: {
    managedBy: [],
    managing: workers,
    talkingWith: [
      row('p1', 'release-bot', 'claude', 'done', {
        role: 'peer',
        hostLabel: 'build-01',
        latest: {
          direction: 'from',
          preview: 'RC cut is Thursday; auth must land by Wed.',
          at: ago(18),
          sequence: 3
        }
      })
    ]
  }
}

const workerRows: OrchestrationCrewSnapshot = {
  status: 'ok',
  sections: {
    managedBy: [
      row('m1', 'coordinator', 'claude', 'working', {
        role: 'manager',
        task: { title: 'Migrate sessions table to token store', state: 'dispatched' },
        latest: {
          direction: 'to',
          preview: 'Migration written; running it against the fixture DB now.',
          at: ago(3),
          sequence: 4
        }
      })
    ],
    managing: [],
    talkingWith: [
      row('p2', 'auth-tests', 'codex', 'working', {
        role: 'peer',
        latest: {
          direction: 'from',
          preview: 'Are you keeping the legacy cookie column?',
          at: ago(2),
          sequence: 5
        }
      }),
      row('p3', 'perf-audit', 'antigravity', 'working', {
        role: 'peer',
        sendAddress: undefined,
        latest: {
          direction: 'from',
          preview: 'Which index does the new token lookup use?',
          at: ago(9),
          sequence: 6
        }
      })
    ]
  }
}

function crew(rows: OrchestrationCrewSnapshot, needsYou: number): NativeChatCrew {
  const { agents } = crewSummary(rows)
  return {
    target: { kind: 'local' },
    canMention: true,
    subscribe: () => () => {},
    read: () => UNKNOWN_CREW_STATE,
    wantRows: () => () => {},
    mention: () => {},
    insertName: () => {},
    summary: { status: 'ok', agents, needsYou },
    rows
  }
}

const tasks: AgentSessionBackgroundTask[] = [
  {
    id: 's1',
    kind: 'agent',
    description: 'Explore session store',
    state: 'working',
    startedAt: Date.now() - 41_000
  },
  {
    id: 's2',
    kind: 'agent',
    description: 'Review migration',
    state: 'working',
    startedAt: Date.now() - 12_000
  },
  {
    id: 'm1',
    kind: 'monitor',
    description: 'CI for #4412',
    state: 'monitoring',
    startedAt: Date.now() - 180_000
  }
]

function strip(props: {
  crew: NativeChatCrew | null
  expanded: boolean
  tasks?: AgentSessionBackgroundTask[]
}) {
  return (
    // The chat's own font rules apply inside the strip, as in a real chat pane.
    <div className="native-chat-appearance bg-chat-canvas" style={nativeChatAppearanceStyle({})}>
      <NativeChatCrewBackgroundTasksStatus
        tasks={props.tasks ?? tasks}
        settledTasks={[]}
        supportsTaskStop
        offersStopAll={false}
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        indicatorActive
        isVisible
        expanded={props.expanded}
        onExpandedChange={() => {}}
        onStop={() => {}}
        onShowAgent={() => {}}
        crew={props.crew}
      />
    </div>
  )
}

export const coordinatorCollapsed = defineFixture({
  width: 720,
  render: () => strip({ crew: crew(coordinatorRows, 1), expanded: false })
})

export const coordinatorOpen = defineFixture({
  width: 720,
  render: () => strip({ crew: crew(coordinatorRows, 1), expanded: true })
})

export const coordinatorNarrow = defineFixture({
  width: 320,
  render: () => strip({ crew: crew(coordinatorRows, 1), expanded: false })
})

export const coordinatorNarrowOpen = defineFixture({
  width: 320,
  render: () => strip({ crew: crew(coordinatorRows, 1), expanded: true })
})

export const workerOpen = defineFixture({
  width: 720,
  render: () => strip({ crew: crew(workerRows, 0), expanded: true, tasks: [] })
})

export const subagentsOnly = defineFixture({
  width: 720,
  render: () => strip({ crew: null, expanded: true })
})

/** A focused worker row swaps its time for Open and Copy, as hover does. */
export const coordinatorRowActions = defineFixture({
  width: 720,
  render: () => strip({ crew: crew(coordinatorRows, 1), expanded: true }),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('li button')?.focus()
  }
})

/** A focused subagent row shows Open and Stop in the same column. */
export const subagentRowActions = defineFixture({
  width: 720,
  render: () => strip({ crew: crew(coordinatorRows, 1), expanded: true }),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[aria-label^="Add Explore"]')?.focus()
  }
})

/** Worker details: the full task and the worker's newest reply, or that it hasn't replied. */
export const workerDetails = defineFixture({
  width: 720,
  render: () => strip({ crew: crew(coordinatorRows, 1), expanded: true }),
  interact: (frame) => {
    frame
      .querySelectorAll<HTMLButtonElement>('[aria-label$="task and reply"]')
      .forEach((button) => button.click())
  }
})
