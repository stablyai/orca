import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { NativeChatSubagentEntry } from '../../../../../shared/native-chat/native-chat-types'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import { NativeChatSubagentViewBar } from './NativeChatSubagentViewBar'
import { NativeChatSubagentStatusBar } from './NativeChatSubagentStatusBar'

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
  {
    id: 'a2',
    label: 'Fix flaky login test',
    state: 'completed',
    tokens: 48_900,
    startedAt: now - 63_000,
    settledAt: now - 12_000,
    model: 'gpt-5.5'
  },
  { id: 'a3', label: 'Map token refresh', state: 'failed', tokens: 8_100 }
]
const entries = new Map(agents.map((agent) => [agent.id, agent]))

function View() {
  return (
    <div
      className="native-chat-appearance flex h-80 flex-col bg-chat-canvas"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatSubagentViewBar
        agentId="a1"
        entries={entries}
        agentsWithRows={new Map([['a4', null]])}
        onOpen={() => {}}
      />
      <div className="flex-1 bg-chat-pane" />
      <NativeChatSubagentStatusBar
        entry={agents[0]}
        stop={{ stopping: false, onStop: () => {} }}
        onBack={() => {}}
      />
    </div>
  )
}

export const open = defineFixture({
  width: 640,
  render: () => <View />
})

export const switcher = defineFixture({
  width: 640,
  render: () => <View />,
  interact: async (frame) => {
    const trigger = frame.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
    trigger?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
