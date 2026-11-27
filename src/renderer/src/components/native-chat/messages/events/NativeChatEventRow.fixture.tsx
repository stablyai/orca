import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import type { BotItemNoteEntry } from '../../../../../../shared/bots/bot-item-note'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { projectStructuredAgentStartItem } from '../../../../../../shared/native-chat/transcript/messages/structured-agent-start-projection'
import { buildNativeChatTranscriptSlots } from '../../conversation/slots/native-chat-transcript-slots'
import { nativeChatSlotKey } from '../../conversation/slots/native-chat-transcript-slot-selection'
import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from '../rows/NativeChatTranscriptRow'
import { NativeChatWorkersContext } from '../../native-chat-workers-context'
import type { OrchestrationSessionWorker } from '../../../../../../shared/orchestration-session-workers'
import { NATIVE_CHAT_ROW_GAP_PX } from '../../viewport/virtualization/native-chat-row-height-estimate'

const at = Date.parse('2026-11-20T15:14:00Z')
const readiness = {
  uid: 'item-1',
  number: 1,
  title: '1.4.268 readiness: three P1s (crash on resume, stale badge, slow open)',
  status: 'working' as const
}
const worker = '# Validate a release readiness finding (investigate only: no code changes, no PRs)'

let rowAt = at
let rowCount = 0
const row = (
  turn: string,
  message: Omit<NativeChatMessage, 'id' | 'timestamp' | 'source'>
): [NativeChatMessage, string] => {
  rowAt += 60_000
  rowCount += 1
  return [{ id: `activity-${rowCount}`, timestamp: rowAt, source: 'transcript', ...message }, turn]
}

function started(turn: string, dispatchId: string): [NativeChatMessage, string] {
  rowAt += 60_000
  rowCount += 1
  const address = dispatchId === 'ctx_1' ? 'term_worker' : 'term_worker_2'
  const message = projectStructuredAgentStartItem({
    itemId: `activity-${rowCount}`,
    revision: 1,
    sequence: rowCount,
    observedAt: rowAt,
    body: {
      kind: 'agent-start',
      dispatchId,
      task: `${worker}\n\nCheck whether the finding reproduces on the release build.`,
      worker: {
        party: { address, terminalHandle: address, orcaSessionId: null },
        name: worker
      }
    }
  })!
  return [message, turn]
}

const linked = (turn: string, dispatchId: string) =>
  row(turn, {
    role: 'system',
    blocks: [],
    botItemNote: {
      noteId: `note-${rowCount}`,
      by: 'bot',
      entries: [
        {
          ...readiness,
          event: 'linked',
          refs: [`dispatch:${dispatchId}`],
          names: { [`dispatch:${dispatchId}`]: worker }
        }
      ]
    }
  })

const addedAndMoved: BotItemNoteEntry[] = [
  { ...readiness, status: 'planned', event: 'made' },
  { ...readiness, status: 'planned', event: 'linked', refs: ['dispatch:ctx_1'] },
  { ...readiness, event: 'status', from: 'planned', to: 'working' }
]

const transcript = [
  row('t1', {
    role: 'system',
    blocks: [],
    automationSaved: {
      change: 'created',
      automation: {
        id: 'auto-1',
        name: 'Release readiness scans for every P0 and P1 on the release board',
        enabled: true,
        nextRunAt: at + 3_600_000,
        updatedAt: at,
        dtstart: at,
        rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
        workspaceId: null
      },
      resultsTo: 'chat'
    }
  }),
  row('t1', {
    role: 'system',
    blocks: [],
    botItemNote: { noteId: 'note-added', by: 'bot', entries: addedAndMoved }
  }),
  started('t1', 'ctx_1'),
  // As in a real chat: the next link lands just before its start card, which comes a moment later.
  linked('t1', 'ctx_2'),
  started('t2', 'ctx_2'),
  row('t3', { role: 'user', blocks: [{ type: 'text', text: 'Link the first worker again.' }] }),
  linked('t3', 'ctx_1')
]

const workspace = 'activity-rows-fixture'
const paneKey = 'worker:11111111-1111-4111-8111-111111111111'
const store = {
  activeWorktreeId: workspace,
  activeWorkspaceExecutionHostId: 'local' as const,
  tabsByWorktree: {
    [workspace]: ['worker', 'worker_2'].map((id) => makeTab({ id, worktreeId: workspace }))
  },
  agentStatusByPaneKey: acceptedAgentStatuses([]).replace([
    [
      paneKey,
      {
        paneKey,
        worktreeId: workspace,
        terminalHandle: 'term_worker',
        agentType: 'claude',
        state: 'working',
        prompt: worker,
        updatedAt: at,
        stateStartedAt: at,
        stateHistory: []
      }
    ]
  ])
}

const context: NativeChatTranscriptRowContext = {
  runtimeContext: { worktreeId: workspace, worktreePath: null, target: { kind: 'local' } },
  expandSignal: false,
  revealedDiff: null,
  taskListPredecessors: new Map(),
  expandedTurnIds: new Set(),
  onToggleExpandedTurn: () => {},
  onScrollMessageToTop: () => {},
  readerAtEnd: () => true,
  onRevealDiff: () => {}
}

/** An agent chat's activity rows as the transcript draws them: a start and its link as one row. */
const workerOf = (dispatchId: string, address: string): OrchestrationSessionWorker => ({
  dispatchId,
  taskId: `task_${dispatchId}`,
  runId: 'run_1',
  title: worker,
  agent: 'claude',
  state: 'working',
  liveness: 'live',
  host: 'local',
  worktreeId: workspace,
  address,
  paneKey: address === 'term_worker' ? paneKey : null,
  chatSessionId: null,
  startedAt: at,
  settledAt: null
})
const workers = [workerOf('ctx_1', 'term_worker'), workerOf('ctx_2', 'term_worker_2')]

function ActivityRows(): React.JSX.Element {
  const slots = buildNativeChatTranscriptSlots({
    messages: transcript.map(([message]) => message),
    turnKeys: transcript.map(([, turn]) => turn),
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false
  })
  return (
    <NativeChatWorkersContext.Provider value={workers}>
      <div className="flex flex-col bg-chat-pane p-4" style={{ gap: NATIVE_CHAT_ROW_GAP_PX }}>
        {slots.map((slot) => (
          <NativeChatTranscriptRow key={nativeChatSlotKey(slot)} slot={slot} context={context} />
        ))}
      </div>
    </NativeChatWorkersContext.Provider>
  )
}

export const activityRows = defineFixture({ width: 680, store, render: () => <ActivityRows /> })

export const activityRowsNarrow = defineFixture({
  width: 400,
  store,
  render: () => <ActivityRows />
})
