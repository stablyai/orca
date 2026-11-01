import { defineFixture } from '../../component-fixtures/component-fixture'
import type { NativeChatSubagentRow } from '../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { NativeChatActivityBar } from './NativeChatActivityBar'

const messages: NativeChatMessage[] = [
  {
    id: 'todo',
    role: 'assistant',
    timestamp: 1,
    source: 'transcript',
    blocks: [
      {
        type: 'tool-call',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Read the transcript', status: 'completed' },
            { content: 'Draw the task pill', status: 'in_progress' },
            { content: 'Open the subagent sheet', status: 'pending' },
            { content: 'Skip the old dock', status: 'cancelled' }
          ]
        }
      },
      {
        type: 'subagent-group',
        groupId: 'turn-1',
        agents: [
          { id: 'child-1', label: 'Explore', state: 'working' },
          { id: 'child-2', label: 'Review', state: 'completed' }
        ]
      }
    ]
  }
]

const child: NativeChatMessage = {
  id: 'child-line',
  role: 'assistant',
  timestamp: 2,
  source: 'transcript',
  agentId: 'child-1',
  blocks: [{ type: 'text', text: 'Found the composer pill.' }]
}

const subagentRows = new Map<string, readonly NativeChatSubagentRow[]>([
  ['child-1', [{ message: child, turnKey: 'turn-1' }]]
])

function bar(focusedSubagentId: string | null = null) {
  return (
    <div className="native-chat-appearance bg-background pt-64">
      <NativeChatActivityBar
        messages={messages}
        subagentRows={subagentRows}
        focusedSubagentId={focusedSubagentId}
        onFocusSubagent={() => {}}
      />
      <div className="px-3 sm:px-4">
        <div className="mx-auto h-16 w-full max-w-(--chat-content-max-width) rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
          Ask anything
        </div>
      </div>
    </div>
  )
}

export const pills = defineFixture({
  width: 420,
  render: () => bar()
})

export const tasksOpen = defineFixture({
  width: 420,
  render: () => bar(),
  interact: (frame) => frame.querySelector<HTMLButtonElement>('button')?.click()
})

export const subagentsOpen = defineFixture({
  width: 420,
  render: () => bar(),
  interact: (frame) => frame.querySelectorAll<HTMLButtonElement>('button')[1]?.click()
})

export const viewing = defineFixture({
  width: 420,
  render: () => bar('child-1')
})
