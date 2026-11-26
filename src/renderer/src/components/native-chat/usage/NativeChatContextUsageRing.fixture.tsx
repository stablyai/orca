import { defineFixture } from '../../../component-fixtures/component-fixture'
import { summarizeContextUsage } from '../../../../../shared/native-chat/native-chat-context-usage-summary'
import { NativeChatContextUsageRing } from './NativeChatContextUsageRing'

const usage = summarizeContextUsage({
  usedTokens: 607_700,
  windowTokens: 1_000_000,
  percentage: 61,
  estimated: false,
  categories: [
    { name: 'System prompt', tokens: 4_100 },
    { name: 'System tools', tokens: 8_900 },
    { name: 'MCP tools (deferred)', tokens: 542_000, deferred: true },
    { name: 'System tools (deferred)', tokens: 17_000, deferred: true },
    { name: 'Memory files', tokens: 5_700 },
    { name: 'Messages', tokens: 589_000 },
    { name: 'Free space', tokens: 359_300 },
    { name: 'Autocompact buffer', tokens: 33_000 }
  ]
})

export const deferredTools = defineFixture({
  width: 360,
  render: () => (
    <div className="flex h-96 items-end justify-end bg-background p-4">
      <NativeChatContextUsageRing usage={usage} />
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[data-native-chat-context-usage]')?.click()
  }
})

// An ACP agent's turn-end usage_update: an estimate with the session's spend.
const acpUsage = summarizeContextUsage({
  usedTokens: 32_602,
  windowTokens: 272_000,
  percentage: 12,
  estimated: true,
  categories: [],
  cost: { amount: 0.11527, currency: 'USD' }
})

export const acpSessionCost = defineFixture({
  width: 360,
  render: () => (
    <div className="flex h-64 items-end justify-end bg-background p-4">
      <NativeChatContextUsageRing usage={acpUsage} />
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[data-native-chat-context-usage]')?.click()
  }
})
