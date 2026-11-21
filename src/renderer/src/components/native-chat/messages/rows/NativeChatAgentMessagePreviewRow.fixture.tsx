import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../../../shared/native-chat/native-chat-types'
import type { AgentMessageSource } from '../../../../../../shared/agent-session/journal/agent-session-message-source'
import type { OrchestrationSessionWorker } from '../../../../../../shared/orchestration-session-workers'
import { projectStructuredAgentStartItem } from '../../../../../../shared/native-chat/transcript/messages/structured-agent-start-projection'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatWorkersContext } from '../../native-chat-workers-context'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'
import { MessageRow } from './NativeChatMessageRow'

// Agent message rows as preview lines: a running task, a message with more below its first line, a
// one-line message shown whole, a long name with a long first line, an image-only message, a start.
const workspace = 'agent-message-preview-fixture'
const runtimeContext = {
  worktreeId: workspace,
  worktreePath: null,
  target: { kind: 'local' as const }
}
const store = {
  activeWorktreeId: workspace,
  activeWorkspaceExecutionHostId: 'local' as const,
  tabsByWorktree: {
    [workspace]: [makeTab({ id: 'builder', worktreeId: workspace })]
  },
  agentStatusByPaneKey: acceptedAgentStatuses([
    [
      'builder:11111111-1111-4111-8111-111111111111',
      {
        paneKey: 'builder:11111111-1111-4111-8111-111111111111',
        worktreeId: workspace,
        terminalHandle: 'term_builder',
        agentType: 'claude',
        state: 'done',
        prompt: 'Build',
        updatedAt: 1_800_000_000_000,
        stateStartedAt: 1_800_000_000_000,
        stateHistory: []
      }
    ]
  ])
}
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAAA8CAIAAADXHaAKAAAAvklEQVR4nO3SUQkAIBTAwBfUAAawP5YQhHFwAfaxWftAxnwvgIcMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSTE0KYYmxdCkGJoUQ5NiaFIMTYqhSbm/mJH95bvMnAAAAABJRU5ErkJggg=='

function mail(
  id: string,
  sender: { name: string; address: string },
  blocks: NativeChatBlock[],
  options: { task?: boolean; minute: number }
): NativeChatMessage & { from: AgentMessageSource } {
  const from: AgentMessageSource = {
    kind: 'agent',
    senders: [
      {
        name: sender.name,
        party: {
          address: sender.address,
          terminalHandle: sender.address.startsWith('term_') ? sender.address : null,
          orcaSessionId: null
        }
      }
    ],
    orchestration: options.task
      ? {
          message: 'task',
          runId: 'r',
          taskId: 't',
          dispatchId: 'task-dispatch'
        }
      : {
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
    blocks,
    timestamp: today + options.minute * 60_000,
    from,
    ...(options.task ? { agentStartDispatchId: 'task-dispatch' } : {})
  }
}

// Today, so rows show the short time a live chat shows.
const today = new Date().setHours(14, 10, 0, 0)
const text = (value: string): NativeChatBlock[] => [{ type: 'text', text: value }]
const reviewer = { name: 'Eng - Reviewer', address: 'dispatch:reviewer' }
const builder = { name: 'Eng-Bot-Builder', address: 'term_builder' }
const longName = {
  name: 'Orchestration builder for the whole team',
  address: 'dispatch:long'
}
const messages = [
  mail(
    'task',
    reviewer,
    text('Review #46231 image notes at 0c644eb.\n\nTwo highs from C1 still open.'),
    {
      task: true,
      minute: 0
    }
  ),
  mail(
    'paused',
    builder,
    text('Paused: waiting on your pick for the toast copy.\n\nTwo options are in the PR.'),
    {
      minute: 2
    }
  ),
  mail('whole', builder, text('Toast copy applied.'), { minute: 5 }),
  mail(
    'long',
    longName,
    text(
      'Finished the memory budget gauge and the settings copy; three screenshots are attached for review in light and dark.\n\nLight and dark, 300 and 720 px.'
    ),
    { minute: 9 }
  ),
  mail('image', longName, [{ type: 'image-ref', url: image, alt: 'Gauge capture' }], { minute: 12 })
]
const started = projectStructuredAgentStartItem({
  itemId: 'preview-started',
  revision: 1,
  sequence: 9,
  observedAt: new Date().setHours(14, 8, 0, 0),
  body: {
    kind: 'agent-start',
    dispatchId: 'start-dispatch',
    task: 'Check the share dialog in light and dark.\n\nPost screenshots when done.',
    worker: {
      party: {
        address: 'dispatch:parser',
        terminalHandle: null,
        orcaSessionId: null
      },
      name: 'Parser worker'
    }
  }
})!
const workers: OrchestrationSessionWorker[] = [
  {
    dispatchId: 'task-dispatch',
    taskId: 't',
    runId: 'r',
    title: 'Eng - Reviewer',
    agent: 'claude',
    state: 'working',
    liveness: 'live',
    host: 'local',
    worktreeId: workspace,
    address: 'dispatch:reviewer',
    paneKey: null,
    chatSessionId: null,
    startedAt: 1_800_000_000_000,
    settledAt: null
  }
]

function rows() {
  return (
    <NativeChatWorkersContext.Provider value={workers}>
      <div className="space-y-1 bg-chat-pane p-4 text-chat-foreground">
        <MessageRow
          message={started}
          expandSignal={false}
          onScrollMessageToTop={() => {}}
          runtimeContext={runtimeContext}
        />
        {messages.map((message) => (
          <NativeChatAgentMessageCard
            key={message.id}
            message={message}
            from={message.from}
            runtimeContext={runtimeContext}
            onRefolded={() => {}}
          />
        ))}
        <p className="pt-1 text-sm">On it. I&apos;ll post when CI is green.</p>
      </div>
    </NativeChatWorkersContext.Provider>
  )
}

const openTwo = (frame: HTMLElement) => {
  const closed = frame.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')
  closed[1]?.click()
  closed[3]?.click()
}
// focusVisible draws the ring a keyboard user sees.
const keyboardFocusOptions: FocusOptions & { focusVisible?: boolean } = {
  focusVisible: true
}
const focusFirst = (frame: HTMLElement) =>
  frame
    .querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')[1]
    ?.focus(keyboardFocusOptions)

export const wide = defineFixture({ width: 720, store, render: rows })
export const medium = defineFixture({ width: 480, store, render: rows })
export const narrow = defineFixture({ width: 300, store, render: rows })
export const openWide = defineFixture({
  width: 720,
  store,
  render: rows,
  interact: openTwo
})
export const openNarrow = defineFixture({
  width: 300,
  store,
  render: rows,
  interact: openTwo
})
export const keyboardFocus = defineFixture({
  width: 480,
  store,
  render: rows,
  interact: focusFirst
})
