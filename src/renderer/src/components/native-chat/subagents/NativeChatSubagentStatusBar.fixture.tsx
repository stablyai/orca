import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { NativeChatSubagentEntry } from '../../../../../shared/native-chat/native-chat-types'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import { NativeChatSubagentStatusBar } from './NativeChatSubagentStatusBar'

const now = Date.now()

const completed: NativeChatSubagentEntry = {
  id: 'a1',
  label: 'Audit auth flow',
  state: 'completed',
  tokens: 17_800,
  startedAt: now - 7_000,
  settledAt: now
}
const failed: NativeChatSubagentEntry = { ...completed, state: 'failed' }
const working: NativeChatSubagentEntry = {
  ...completed,
  state: 'working',
  settledAt: undefined,
  startedAt: now - 42_000
}

function Bar(props: React.ComponentProps<typeof NativeChatSubagentStatusBar>) {
  return (
    <div className="native-chat-appearance bg-chat-canvas" style={nativeChatAppearanceStyle({})}>
      <NativeChatSubagentStatusBar {...props} />
    </div>
  )
}

export const completedWide = defineFixture({
  width: 640,
  render: () => <Bar entry={completed} onBack={() => {}} />
})

export const failedNarrow = defineFixture({
  width: 340,
  render: () => <Bar entry={failed} onBack={() => {}} />
})

export const stopping = defineFixture({
  width: 640,
  render: () => (
    <Bar
      entry={working}
      stop={{ stopping: true, onStop: () => {} }}
      backTo="Audit auth flow"
      onBack={() => {}}
    />
  )
})

export const stoppingNarrow = defineFixture({
  width: 340,
  render: () => (
    <Bar entry={working} stop={{ stopping: true, onStop: () => {} }} onBack={() => {}} />
  )
})
