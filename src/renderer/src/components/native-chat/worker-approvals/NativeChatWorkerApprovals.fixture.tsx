import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatMessageList } from '../NativeChatMessageList'
import type { NativeChatLiveSession } from '../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { NativeChatApprovalCard } from '../prompts/NativeChatApprovalCard'
import {
  NativeChatWorkerApprovalRows,
  NativeChatWorkerApprovalStrip,
  type NativeChatWorkerApproval
} from './NativeChatWorkerApprovals'
import type { OrchestrationCrewRow } from '../../../../../shared/orchestration/orchestration-crew'
import type {
  WorkerApprovalOutcome,
  WorkerApprovalPayload
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'

const command = `cd ~/orca/workspaces/orca/github-install && python3 - <<'EOF'
import json, pathlib
spec = json.loads(pathlib.Path("dialog.json").read_text())
print(f"\`{spec['title']}\` -> \${spec['id']}")
EOF`
const reason =
  'Dangerous rm operation not ruled out: the shell may read this command differently than it was parsed.'
const at = '2026-11-10T20:41:00.000Z'

function worker(label: string): OrchestrationCrewRow {
  return {
    partyKey: label,
    role: 'worker',
    label,
    agentKind: 'claude',
    status: 'blocked',
    openTarget: { kind: 'terminal', handle: `term_${label}` }
  }
}

function approval(
  id: string,
  summary: WorkerApprovalPayload['summary'],
  extra: Partial<WorkerApprovalPayload> = {}
): WorkerApprovalPayload {
  return {
    v: 1,
    approvalId: id,
    state: 'open',
    worker: { handle: 'term_worker', dispatchId: 'ctx_fixture', taskId: 'task_fixture' },
    summary,
    allowedActions: ['allow', 'deny'],
    ...extra
  }
}

const bash = { title: 'Allow Bash?', detail: command, reason }
const github = worker('github-install-dialog')
const docs = worker('docs-copy-pass')
// Far enough out that the countdown line always renders.
const expiresAt = new Date(Date.now() + 102_000).toISOString()

const openBash: NativeChatWorkerApproval = {
  approval: approval('apr_bash', bash, { expiresAt }),
  at,
  worker: github
}
const openDocs: NativeChatWorkerApproval = {
  approval: approval('apr_docs', {
    title: 'Apply file changes?',
    detail: 'update docs/STYLEGUIDE.md\n@@ -12 +12 @@\n-Use title case.\n+Use sentence case.',
    reason: null
  }),
  at,
  worker: docs
}
const target = { kind: 'local' } as const
const root = { current: null }

const composer = (
  <div className="px-3 pt-2 sm:px-4">
    <div className="mx-auto h-20 w-full max-w-(--chat-content-max-width) rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
      Ask anything, @ to mention files, / for commands
    </div>
  </div>
)

export const open = defineFixture({
  width: 760,
  render: () => (
    <div className="native-chat-appearance bg-chat-pane py-4">
      <NativeChatWorkerApprovalRows approvals={[openBash]} target={target} />
    </div>
  )
})

export const several = defineFixture({
  width: 760,
  render: () => (
    <div className="native-chat-appearance bg-chat-pane pt-4 pb-3">
      <NativeChatWorkerApprovalRows approvals={[openBash, openDocs]} target={target} />
      <NativeChatWorkerApprovalStrip approvals={[openBash, openDocs]} rootRef={root} />
      {composer}
    </div>
  )
})

export const coordinatorBusy = defineFixture({
  width: 760,
  render: () => (
    <div className="native-chat-appearance bg-chat-pane pt-3 pb-3">
      <NativeChatWorkerApprovalStrip approvals={[openBash, openDocs]} rootRef={root} />
      <NativeChatApprovalCard
        approval={{
          title: 'Allow Read?',
          detail: '~/orca-lanes/worker-prompt-stall/plan.html',
          options: [
            { label: 'Allow', send: 'allow' },
            { label: 'Deny', send: 'deny' }
          ]
        }}
        onChoose={() => {}}
        onCancel={() => {}}
      />
    </div>
  )
})

function closed(
  id: string,
  outcome: WorkerApprovalOutcome,
  row: OrchestrationCrewRow = github
): NativeChatWorkerApproval {
  return {
    approval: approval(id, bash, {
      state: outcome.by === 'auto' ? 'expired' : 'answered',
      allowedActions: [],
      outcome
    }),
    at,
    worker: row
  }
}

export const answered = defineFixture({
  width: 760,
  render: () => (
    <div className="native-chat-appearance bg-chat-pane py-3">
      <NativeChatWorkerApprovalRows
        target={target}
        approvals={[
          closed('a', { by: 'person', decision: 'allow', reason: null, reasonDelivered: false }),
          closed('b', {
            by: 'person',
            decision: 'deny',
            reason: 'Denied by the owner.',
            reasonDelivered: true
          }),
          closed('c', {
            by: 'coordinator',
            decision: 'deny',
            reason:
              'Write the script to scripts/dialog_title.py and run it with python3 instead of a heredoc.',
            reasonDelivered: true
          }),
          closed('d', {
            by: 'worker-terminal',
            decision: 'allow',
            reason: null,
            reasonDelivered: false
          }),
          closed('e', {
            by: 'worker-terminal',
            decision: 'deny',
            reason: null,
            reasonDelivered: false
          }),
          closed(
            'f',
            { by: 'worker-chat', decision: 'allow', reason: null, reasonDelivered: false },
            docs
          ),
          closed('g', { by: 'auto', decision: 'deny', reason: null, reasonDelivered: false }),
          closed('h', {
            by: 'terminal-only',
            decision: null,
            reason: null,
            reasonDelivered: false
          }),
          closed('i', { by: 'unknown', decision: null, reason: null, reasonDelivered: false })
        ]}
      />
    </div>
  )
})

// A coordinator chat that kept replying after a worker asked twice: each card sits at its own time.
const CHAT_START = Date.parse('2026-11-11T20:09:00.000Z')
function reply(id: string, role: NativeChatMessage['role'], minute: number, text: string) {
  const message: NativeChatMessage = {
    id,
    role,
    source: 'transcript',
    timestamp: CHAT_START + minute * 60_000,
    blocks: [{ type: 'text', text }]
  }
  return message
}
const transcript: NativeChatLiveSession = {
  messages: [
    reply('ask', 'user', 0, 'Have a worker build the bot settings page.'),
    reply('started', 'assistant', 1, 'A worker is on it in dungeness.'),
    reply('status', 'user', 4, 'How is it going?'),
    reply('answer', 'assistant', 5, 'It finished the settings rows and is wiring the avatar now.'),
    reply('next', 'user', 7, 'Also check the tree spacing.'),
    reply('ack', 'assistant', 8, 'Added it to the worker task.')
  ],
  agent: 'claude',
  sessionId: 'fixture',
  status: 'ready',
  readPhase: 'ready',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: async () => 'applied'
}
const allowedAt = new Date(CHAT_START + 2.5 * 60_000).toISOString()
const askedLater = new Date(CHAT_START + 6.5 * 60_000).toISOString()

export const inTranscript = defineFixture({
  width: 760,
  render: () => (
    <div className="native-chat-appearance flex h-[760px] flex-col bg-chat-pane">
      <NativeChatMessageList
        session={transcript}
        isWorking={false}
        expandSignal={false}
        timedRows={[
          {
            ...closed('allowed', {
              by: 'person',
              decision: 'allow',
              reason: null,
              reasonDelivered: false
            }),
            at: allowedAt
          },
          { ...openBash, at: askedLater }
        ].map((entry) => ({
          key: entry.approval.approvalId,
          at: Date.parse(entry.at),
          node: <NativeChatWorkerApprovalRows approvals={[entry]} target={target} />
        }))}
      />
    </div>
  )
})
