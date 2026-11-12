import { defineFixture } from '../../../component-fixtures/component-fixture'
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
      state: outcome.decision ? 'answered' : 'expired',
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
          closed('a', { by: 'person', decision: 'allow', reason: null, reasonDelivered: true }),
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
            reasonDelivered: true
          }),
          closed('e', {
            by: 'worker-terminal',
            decision: 'deny',
            reason: null,
            reasonDelivered: true
          }),
          closed(
            'f',
            { by: 'worker-chat', decision: 'allow', reason: null, reasonDelivered: false },
            docs
          ),
          closed('g', { by: 'auto', decision: 'deny', reason: null, reasonDelivered: true }),
          closed('h', {
            by: 'terminal-only',
            decision: null,
            reason: null,
            reasonDelivered: true
          }),
          closed('i', { by: 'unknown', decision: null, reason: null, reasonDelivered: false })
        ]}
      />
    </div>
  )
})
