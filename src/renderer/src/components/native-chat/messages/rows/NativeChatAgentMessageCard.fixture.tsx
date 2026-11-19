import {
  acceptedAgentStatuses,
  type AcceptedAgentStatuses
} from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import type { AgentMessageSource } from '../../../../../../shared/agent-session/journal/agent-session-message-source'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'
import { MessageRow } from './NativeChatMessageRow'
import { projectStructuredAgentStartItem } from '../../../../../../shared/native-chat/transcript/messages/structured-agent-start-projection'
import { NativeChatUserMessageRow } from './NativeChatUserMessageRow'
import { orchestrationMailFixture } from '../../../../../../shared/agent-session/orchestration-mail.test-fixture'
import { NativeChatWorkersContext } from '../../native-chat-workers-context'
import type { OrchestrationSessionWorker } from '../../../../../../shared/orchestration-session-workers'

const workspace = 'agent-message-fixture'
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAAA8CAIAAADXHaAKAAAAvklEQVR4nO3SUQkAIBTAwBfUAAawP5YQhHFwAfaxWftAxnwvgIcMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSbm/mJH95bvMnAAAAABJRU5ErkJggg=='
const prose =
  'First paragraph with **real Markdown**, a [web link](https://example.com) and inline `code`.\n\nSecond paragraph keeps its own spacing. This longer line wraps differently in the narrow frame, so Show more is based on rendered lines.\n\n![Example image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAAA8CAIAAADXHaAKAAAAvklEQVR4nO3SUQkAIBTAwBfUAAawP5YQhHFwAfaxWftAxnwvgIcMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSbm/mJH95bvMnAAAAABJRU5ErkJggg==)\n\nLast paragraph after the image.'
const started = projectStructuredAgentStartItem({
  itemId: 'started',
  revision: 1,
  sequence: 7,
  observedAt: 1_800_000_000_000,
  body: {
    kind: 'agent-start',
    dispatchId: 'fixture-dispatch',
    task: prose,
    worker: {
      party: { address: 'term_sender', terminalHandle: 'term_sender', orcaSessionId: null },
      name: 'Parser worker'
    }
  }
})!
function cards() {
  const human: NativeChatMessage = {
    id: 'human',
    role: 'user',
    source: 'transcript',
    blocks: [{ type: 'text', text: 'An ordinary human message.' }],
    timestamp: 1_800_000_000_000
  }
  return (
    <div className="space-y-4 bg-chat-pane p-4">
      {[
        started,
        { ...started, id: 'reopened', agentFollowUp: 'reopened' as const },
        { ...started, id: 'followed-up', agentFollowUp: 'fresh' as const }
      ].map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          expandSignal={false}
          onScrollMessageToTop={() => {}}
          runtimeContext={{ worktreeId: workspace, worktreePath: null, target: { kind: 'local' } }}
        />
      ))}
      {(['task', 'coordinator', 'worker', 'generic'] as const).map((kind, i) => {
        const from: AgentMessageSource = {
          kind: 'agent',
          senders: (kind === 'generic'
            ? ['A sender on another host with a long name', null, 'Parser worker', 'Fourth sender']
            : ['Parser worker']
          ).map((name, index) => {
            const address =
              kind === 'generic' && index === 0
                ? 'dispatch:missing'
                : kind === 'task'
                  ? 'term_progress'
                  : `term_sender${index || ''}`
            return {
              party: {
                address,
                terminalHandle: kind === 'generic' && index === 0 ? null : address,
                orcaSessionId: null
              },
              name,
              ...(kind === 'worker' || kind === 'coordinator' ? { relation: kind } : {})
            }
          }),
          orchestration:
            kind === 'task'
              ? { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
              : {
                  message: 'mail-notice',
                  mailbox: 'term_recipient',
                  dispatchId: null,
                  messages: []
                }
        }
        return (
          <NativeChatAgentMessageCard
            key={kind}
            message={{
              id: kind,
              role: 'user',
              source: 'transcript',
              blocks: [
                {
                  type: 'text',
                  text: i === 0 ? 'A short task opens from its one-line header.' : prose
                },
                ...(kind === 'generic'
                  ? [{ type: 'image-ref' as const, url: image, alt: 'Attached diagram' }]
                  : [])
              ],
              timestamp: 1_800_000_000_000,
              from
            }}
            from={from}
            runtimeContext={{
              worktreeId: workspace,
              worktreePath: null,
              target: { kind: 'local' }
            }}
            onRefolded={() => {}}
          />
        )
      })}
      <NativeChatUserMessageRow
        message={human}
        markdown="An ordinary human message."
        prose={human.blocks}
        rowRef={{ current: null }}
        onRefolded={() => {}}
      />
    </div>
  )
}
let agentStatusByPaneKey: AcceptedAgentStatuses = acceptedAgentStatuses(Object.entries({}))
for (const [id, agentType, state] of [
  ['sender', 'codex', 'done'],
  ['progress', 'claude', 'working']
] as const) {
  const paneKey = `${id}:11111111-1111-4111-8111-111111111111`
  agentStatusByPaneKey = agentStatusByPaneKey.replace([
    [
      paneKey,
      {
        paneKey,
        worktreeId: workspace,
        terminalHandle: `term_${id}`,
        agentType,
        state,
        prompt: 'Parser worker',
        updatedAt: 1_800_000_000_000,
        stateStartedAt: 1_800_000_000_000,
        stateHistory: [],
        ...(state === 'working'
          ? { programStatus: { state, progress: 40, observedAt: 1_800_000_000_000 } }
          : {})
      }
    ]
  ])
}
const store = {
  activeWorktreeId: workspace,
  activeWorkspaceExecutionHostId: 'local' as const,
  tabsByWorktree: {
    [workspace]: ['sender', 'progress'].map((id) => makeTab({ id, worktreeId: workspace }))
  },
  agentStatusByPaneKey
}

export const wide = defineFixture({ width: 720, store, render: cards })
export const narrow = defineFixture({ width: 340, store, render: cards })
export const medium = defineFixture({ width: 440, store, render: cards })
export const mail = defineFixture({
  width: 720,
  render: () => {
    const message = orchestrationMailFixture({
      body: 'The message now shows the result directly.\n\nAll relevant checks passed. Open [the report](https://example.com/report) for details.'
    })
    return (
      <div className="bg-chat-pane p-4">
        <NativeChatAgentMessageCard
          message={{ ...message, timestamp: 1_800_000_000_000 }}
          from={message.from}
          onRefolded={() => {}}
        />
      </div>
    )
  },
  interact: (frame) =>
    frame.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
})
export const expanded = defineFixture({
  width: 720,
  store,
  render: cards,
  interact: (frame) => {
    for (const button of frame.querySelectorAll('button')) {
      if (button.getAttribute('aria-expanded') === 'false') {
        button.click()
      }
    }
  }
})
// Mail from a paired computer: an agent there by its carried avatar, and a terminal agent, each with its host pill.
export const fromAnotherComputer = defineFixture({
  width: 440,
  render: () => (
    <div className="space-y-4 bg-chat-pane p-4">
      {[
        { name: 'Release helper', bot: true as const, botAvatar: 'mascot:A1', agent: 'claude' },
        { name: 'Release check', agent: 'codex' }
      ].map((sender) => {
        const from: AgentMessageSource = {
          kind: 'agent',
          senders: [
            {
              party: {
                address: `${sender.name} on Alice's Mac`,
                terminalHandle: null,
                orcaSessionId: null
              },
              host: "Alice's Mac",
              ...sender
            }
          ],
          orchestration: {
            message: 'mail-notice',
            mailbox: 'term_recipient',
            dispatchId: null,
            messages: []
          }
        }
        return (
          <NativeChatAgentMessageCard
            key={sender.name}
            message={{
              id: sender.name,
              role: 'user',
              source: 'transcript',
              blocks: [{ type: 'text', text: 'Where is the install guide?' }],
              timestamp: 1_800_000_000_000,
              from
            }}
            from={from}
            onRefolded={() => {}}
          />
        )
      })}
    </div>
  )
})

function sessionWorker(
  dispatchId: string,
  state: OrchestrationSessionWorker['state'],
  address: string
): OrchestrationSessionWorker {
  return {
    dispatchId,
    taskId: 't',
    runId: 'r',
    title: 'Parser worker',
    agent: 'claude',
    state,
    liveness: state === 'working' ? 'live' : 'exited',
    host: 'local',
    worktreeId: workspace,
    address,
    paneKey: null,
    chatSessionId: null,
    startedAt: 1_800_000_000_000,
    settledAt: state === 'working' ? null : 1_800_000_060_000
  }
}

// The chat's own workers as the host records them: one still running (spinner on its start), one
// whose Dispatch failed (red badge on its update), whatever its pane shows now.
const failedUpdate = {
  ...orchestrationMailFixture({ body: 'Stopped: the screenshot tool timed out.' }),
  timestamp: 1_800_000_030_000
}
const recordedWorkers = [
  sessionWorker('fixture-dispatch', 'working', 'term_sender'),
  sessionWorker('failed-dispatch', 'failed', failedUpdate.from.senders[0]!.party.address)
]
export const workerStates = defineFixture({
  width: 560,
  store,
  render: () => {
    const update = failedUpdate
    return (
      <NativeChatWorkersContext.Provider value={recordedWorkers}>
        <div className="space-y-1 bg-chat-pane p-4">
          <MessageRow
            message={started}
            expandSignal={false}
            onScrollMessageToTop={() => {}}
            runtimeContext={{
              worktreeId: workspace,
              worktreePath: null,
              target: { kind: 'local' }
            }}
          />
          <NativeChatAgentMessageCard message={update} from={update.from} onRefolded={() => {}} />
        </div>
      </NativeChatWorkersContext.Provider>
    )
  }
})
