import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { AgentMessageSource } from '../../../../../../shared/agent-session/journal/agent-session-message-source'
import type { OrchestrationSessionWorker } from '../../../../../../shared/orchestration-session-workers'
import { projectStructuredAgentStartItem } from '../../../../../../shared/native-chat/transcript/messages/structured-agent-start-projection'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatWorkersContext } from '../../native-chat-workers-context'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'
import { MessageRow } from './NativeChatMessageRow'

const workspace = 'agent-message-chips-fixture'
const runtimeContext = {
  worktreeId: workspace,
  worktreePath: null,
  target: { kind: 'local' as const }
}
const terminals = [
  ['sender', 'codex', 'working'],
  ['long', 'claude', 'done'],
  ['done', 'codex', 'done']
] as const
const store = {
  activeWorktreeId: workspace,
  activeWorkspaceExecutionHostId: 'local' as const,
  tabsByWorktree: {
    [workspace]: terminals.map(([id]) => makeTab({ id, worktreeId: workspace }))
  },
  agentStatusByPaneKey: acceptedAgentStatuses(
    terminals.map(([id, agentType, state]) => {
      const paneKey = `${id}:11111111-1111-4111-8111-111111111111`
      return [
        paneKey,
        {
          paneKey,
          worktreeId: workspace,
          terminalHandle: `term_${id}`,
          agentType,
          state,
          prompt: 'Review',
          updatedAt: 1_800_000_000_000,
          stateStartedAt: 1_800_000_000_000,
          stateHistory: []
        }
      ]
    })
  )
}

function sessionWorker(
  dispatchId: string,
  state: OrchestrationSessionWorker['state'],
  address: string,
  title: string
): OrchestrationSessionWorker {
  return {
    dispatchId,
    taskId: 't',
    runId: 'r',
    title,
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

// Worker names as chips: running, failed and done workers, a long name cut in its chip, a sender this
// chat can't open (plain), several senders with one chip each, and an agent with its host pill.
const longName = 'Independent catalog review for the share dialog and its frozen release commit'
function chipMail(
  id: string,
  senders: { name: string; address: string; host?: string }[],
  options: { worker?: boolean; text?: string } = {}
): NativeChatMessage & { from: AgentMessageSource } {
  const from: AgentMessageSource = {
    kind: 'agent',
    senders: senders.map(({ name, address, host }) => ({
      party: {
        address,
        terminalHandle: address.startsWith('term_') ? address : null,
        orcaSessionId: null
      },
      name,
      ...(host ? { host } : {}),
      ...(options.worker ? { relation: 'worker' as const } : {})
    })),
    orchestration: {
      message: 'mail-notice',
      mailbox: 'term_recipient',
      dispatchId: null,
      messages: []
    }
  }
  return {
    id,
    role: 'user',
    source: 'transcript',
    blocks: [
      { type: 'text', text: options.text ?? 'The share dialog change is ready for review.' }
    ],
    timestamp: 1_800_000_000_000,
    from
  }
}
const chipStarted = projectStructuredAgentStartItem({
  itemId: 'chip-started',
  revision: 1,
  sequence: 9,
  observedAt: 1_800_000_000_000,
  body: {
    kind: 'agent-start',
    dispatchId: 'chip-running',
    task: 'Review the share dialog change and run its tests.',
    worker: {
      party: { address: 'term_sender', terminalHandle: 'term_sender', orcaSessionId: null },
      name: 'Parser worker',
      agent: 'codex'
    }
  }
})!
const chipMessages = [
  chipMail('chip-failed', [{ name: longName, address: 'term_long' }], {
    worker: true,
    text: 'Stopped: the screenshot tool timed out.'
  }),
  chipMail('chip-done', [{ name: 'Docs worker', address: 'term_done' }], { worker: true }),
  chipMail('chip-remote', [{ name: 'Release check on another host', address: 'dispatch:remote' }]),
  chipMail('chip-several', [
    { name: 'Parser worker', address: 'term_sender' },
    { name: longName, address: 'term_long' },
    { name: 'Docs worker', address: 'term_done' },
    { name: 'Fourth sender', address: 'term_fourth' }
  ]),
  chipMail('chip-paired', [
    { name: 'Release helper', address: 'Release helper on Test Mac', host: 'Test Mac' }
  ])
]
const chipWorkers = [
  { ...sessionWorker('chip-running', 'working', 'term_sender', 'Parser worker'), agent: 'codex' },
  sessionWorker('chip-failed', 'failed', 'term_long', longName),
  sessionWorker('chip-done', 'completed', 'term_done', 'Docs worker')
]
function chipRows() {
  return (
    <NativeChatWorkersContext.Provider value={chipWorkers}>
      <div className="space-y-1 bg-chat-pane p-4">
        <MessageRow
          message={chipStarted}
          expandSignal={false}
          onScrollMessageToTop={() => {}}
          runtimeContext={runtimeContext}
        />
        {chipMessages.map((message) => (
          <NativeChatAgentMessageCard
            key={message.id}
            message={message}
            from={message.from}
            runtimeContext={{
              worktreeId: workspace,
              worktreePath: null,
              target: { kind: 'local' }
            }}
            onRefolded={() => {}}
          />
        ))}
      </div>
    </NativeChatWorkersContext.Provider>
  )
}
export const wide = defineFixture({ width: 560, store, render: chipRows })
export const narrow = defineFixture({ width: 300, store, render: chipRows })
export const narrowFocused = defineFixture({
  width: 300,
  store,
  render: chipRows,
  interact: (frame) => frame.querySelector<HTMLButtonElement>('button[aria-label^="Open"]')?.focus()
})
export const expanded = defineFixture({
  width: 560,
  store,
  render: chipRows,
  interact: (frame) =>
    frame.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
})
