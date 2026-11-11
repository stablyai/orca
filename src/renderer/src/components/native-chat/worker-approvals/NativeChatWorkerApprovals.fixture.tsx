import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatMessageList } from '../NativeChatMessageList'
import type { NativeChatLiveSession } from '../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { NativeChatApprovalCard } from '../prompts/NativeChatApprovalCard'
import {
  NativeChatWorkerApprovalReceipt,
  NativeChatWorkerApprovalStack
} from './NativeChatWorkerApprovals'
import type { NativeChatWorkerApproval } from './native-chat-worker-approval-feed'
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

const composer = (
  <div className="px-3 pt-2 sm:px-4">
    <div className="mx-auto h-20 w-full max-w-(--chat-content-max-width) rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
      Ask anything, @ to mention files, / for commands
    </div>
  </div>
)

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
      {[
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
      ].map((entry) => (
        <NativeChatWorkerApprovalReceipt key={entry.approval.approvalId} entry={entry} />
      ))}
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

const allowed = {
  ...closed('allowed', { by: 'person', decision: 'allow', reason: null, reasonDelivered: false }),
  at: allowedAt
}

/** The coordinator chat as the pane lays it out: transcript with receipts, then the pinned stack,
 *  the chat's own prompt, and the composer. */
function pane(stack: readonly NativeChatWorkerApproval[], ownPrompt = false): React.JSX.Element {
  return (
    <div className="native-chat-appearance flex h-[760px] flex-col bg-chat-pane pb-3">
      <NativeChatMessageList
        session={transcript}
        isWorking={false}
        expandSignal={false}
        timedRows={[
          {
            key: allowed.approval.approvalId,
            at: Date.parse(allowed.at),
            node: <NativeChatWorkerApprovalReceipt entry={allowed} />
          }
        ]}
      />
      <NativeChatWorkerApprovalStack approvals={stack} target={target} />
      {ownPrompt ? (
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
      ) : null}
      {composer}
    </div>
  )
}

export const oneOpen = defineFixture({ width: 760, render: () => pane([openBash]) })

export const twoOpen = defineFixture({ width: 760, render: () => pane([openBash, openDocs]) })

export const openWithOwnPrompt = defineFixture({
  width: 760,
  render: () => pane([openBash], true)
})

export const receiptInPlace = defineFixture({ width: 760, render: () => pane([]) })
