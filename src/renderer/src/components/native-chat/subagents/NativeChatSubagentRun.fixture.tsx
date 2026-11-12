import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { NativeChatSubagentGroupBlock } from '../../../../../shared/native-chat/native-chat-types'
import { NativeChatSubagentRun } from './NativeChatSubagentRun'

const now = Date.now()

const block: NativeChatSubagentGroupBlock = {
  type: 'subagent-group',
  groupId: 'turn-1',
  agents: [
    {
      id: 'a1',
      label: 'Audit auth flow',
      state: 'working',
      tokens: 31_200,
      startedAt: now - 42_000,
      agentType: 'Explore',
      model: 'claude-opus-5-5',
      operation: { toolName: 'Read', input: 'src/auth/session.ts' }
    },
    {
      id: 'a2',
      label: 'Fix flaky login test',
      state: 'working',
      tokens: 48_900,
      startedAt: now - 63_000,
      model: 'gpt-5.5',
      effort: 'medium',
      operation: { toolName: 'Bash', input: 'pnpm test login.spec.ts' }
    },
    {
      id: 'a3',
      label: 'Map token refresh',
      state: 'completed',
      tokens: 8_100,
      startedAt: now - 80_000,
      settledAt: now - 62_000,
      model: 'claude-haiku-5-5',
      lastMessage:
        'Refresh happens in two places: the middleware retries once on 401, and the client refreshes on a timer 60 s before expiry.'
    }
  ]
}

function Roster() {
  return (
    <div className="native-chat-appearance p-4 pt-36">
      <NativeChatSubagentRun block={block} open onSetOpen={() => {}} />
    </div>
  )
}

export const enriched = defineFixture({
  width: 560,
  render: () => <Roster />
})

export const hovered = defineFixture({
  width: 560,
  render: () => <Roster />,
  interact: async (frame) => {
    frame
      .querySelector('[data-native-chat-subagent-entry="a3"] > div')
      ?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})
