import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { NativeChatSubagentEntry } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import { NativeChatSubagentViewBar } from './NativeChatSubagentViewBar'

const now = Date.now()

const agents: NativeChatSubagentEntry[] = [
  {
    id: 'a1',
    label: 'Audit auth flow',
    state: 'working',
    tokens: 31_200,
    startedAt: now - 42_000,
    agentType: 'general-purpose',
    model: 'claude-opus-5-5',
    effort: 'high'
  },
  { id: 'a2', label: 'List docs/ and read notes.md', state: 'completed', model: 'gpt-5.5' },
  { id: 'a3', label: 'Map token refresh', state: 'failed', tokens: 8_100 },
  { id: 'a4', label: 'Check refresh race', state: 'working', agentType: 'Explore' }
]
const entries = new Map(agents.map((agent) => [agent.id, agent]))

function rows(id: string, parentAgentId?: string): [string, NativeChatSubagentRow[]] {
  return [
    id,
    [
      {
        message: {
          id: `${id}-row`,
          role: 'assistant',
          blocks: [],
          timestamp: now,
          source: 'transcript',
          ...(parentAgentId ? { parentAgentId } : {})
        },
        turnKey: undefined
      }
    ]
  ]
}
// a4 was spawned by a1; two unnamed agents have rows and no roster entry.
const subagentRows = new Map([rows('a1'), rows('a4', 'a1'), rows('u1'), rows('u2')])

function Bar() {
  return (
    <div
      className="native-chat-appearance h-96 bg-chat-canvas"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatSubagentViewBar
        chain={['a1', 'a4']}
        entries={entries}
        subagentRows={subagentRows}
        onOpen={() => {}}
      />
    </div>
  )
}

export const nested = defineFixture({ width: 640, render: () => <Bar /> })

export const switcher = defineFixture({
  width: 640,
  render: () => <Bar />,
  interact: async (frame) => {
    frame
      .querySelector('[aria-haspopup="menu"]')
      ?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      )
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
