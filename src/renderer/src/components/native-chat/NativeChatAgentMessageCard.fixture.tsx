import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { makeTab } from '@/store/slices/store-test-helpers'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'
import { MessageRow } from './NativeChatMessageRow'
import { projectStructuredAgentStartItem } from '../../../../shared/structured-agent-start-projection'
import { NativeChatUserMessageRow } from './NativeChatUserMessageRow'
import { orchestrationMailFixture } from '../../../../shared/agent-session/orchestration-mail.test-fixture'

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
    <div className="space-y-4 p-4">
      <MessageRow
        message={started}
        expandSignal={false}
        onScrollMessageToTop={() => {}}
        runtimeContext={{ worktreeId: workspace, worktreePath: null, target: { kind: 'local' } }}
      />
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
                { type: 'text', text: i === 0 ? 'A short task fits without a disclosure.' : prose },
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
            allowFileUriLinks={false}
            onRefolded={() => {}}
          />
        )
      })}
      <NativeChatUserMessageRow
        message={human}
        markdown="An ordinary human message."
        prose={human.blocks}
        rowRef={{ current: null }}
        allowFileUriLinks={false}
        onRefolded={() => {}}
      />
    </div>
  )
}
const agentStatusByPaneKey: Record<string, AgentStatusEntry> = {}
for (const [id, agentType, state] of [
  ['sender', 'codex', 'done'],
  ['progress', 'claude', 'working']
] as const) {
  const paneKey = `${id}:11111111-1111-4111-8111-111111111111`
  agentStatusByPaneKey[paneKey] = {
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
export const commandSource = defineFixture({
  width: 720,
  render: () => {
    const message: NativeChatMessage & { from: AgentMessageSource } = {
      id: 'command-complete',
      role: 'user',
      source: 'transcript',
      timestamp: 1_800_000_000_000,
      blocks: [{ type: 'text', text: 'CI completed successfully. The review can continue.' }],
      from: {
        kind: 'agent',
        orchestration: null,
        senders: [
          {
            name: null,
            party: { address: 'ci-notifier', terminalHandle: 'ci-notifier', orcaSessionId: null }
          }
        ]
      }
    }
    return (
      <div className="p-4">
        <NativeChatAgentMessageCard
          message={message}
          from={message.from}
          allowFileUriLinks={false}
          onRefolded={() => {}}
        />
      </div>
    )
  }
})
export const medium = defineFixture({ width: 440, store, render: cards })
export const mail = defineFixture({
  width: 720,
  render: () => {
    const message = orchestrationMailFixture({
      body: 'The message now shows the result directly.\n\nAll relevant checks passed. Open [the report](https://example.com/report) for details.'
    })
    return (
      <div className="p-4">
        <NativeChatAgentMessageCard
          message={message}
          from={message.from}
          allowFileUriLinks={false}
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
