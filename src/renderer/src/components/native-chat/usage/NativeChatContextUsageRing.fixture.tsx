import { defineFixture } from '../../../component-fixtures/component-fixture'
import { summarizeContextUsage } from '../../../../../shared/native-chat/native-chat-context-usage-summary'
import { NativeChatContextUsageRing } from './NativeChatContextUsageRing'

const usage = summarizeContextUsage({
  usedTokens: 607_700,
  windowTokens: 1_000_000,
  percentage: 61,
  estimated: false,
  categories: [
    { name: 'Messages', tokens: 589_000 },
    { name: 'MCP tools (deferred)', tokens: 542_000, deferred: true },
    { name: 'System prompt', tokens: 12_000 },
    { name: 'System tools (deferred)', tokens: 17_000, deferred: true },
    { name: 'Memory files', tokens: 6_700 }
  ]
})

export const deferredTools = defineFixture({
  width: 360,
  render: () => (
    <div className="native-chat-appearance flex h-112 items-end justify-end p-4">
      <NativeChatContextUsageRing usage={usage} />
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[data-native-chat-context-usage]')?.click()
  }
})
