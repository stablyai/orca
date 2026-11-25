import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatTokenUsageFooter } from './NativeChatTokenUsageFooter'
import type { NativeChatContextUsageSummary } from '../../../../../shared/native-chat/native-chat-context-usage-summary'

const usage: NativeChatContextUsageSummary = {
  usedTokens: 64_000,
  windowTokens: 256_000,
  percentage: 25,
  estimated: false,
  rows: [],
  tokenUsage: {
    scope: 'session',
    counts: {
      inputTokens: 80_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 240_000,
      outputTokens: 12_000
    }
  }
}

function footerFixture(value: NativeChatContextUsageSummary | null, width = 640) {
  return defineFixture({
    width,
    render: () => (
      <div className="native-chat-appearance bg-chat-pane p-3">
        <NativeChatTokenUsageFooter usage={value} />
      </div>
    )
  })
}

export const session = footerFixture(usage)
export const narrow = footerFixture(usage, 320)
export const response = footerFixture({
  ...usage,
  estimated: true,
  tokenUsage: { scope: 'response', counts: usage.tokenUsage!.counts }
})
export const unavailable = footerFixture(null)
export const contextOnly = footerFixture({ ...usage, tokenUsage: undefined })
export const overLimit = footerFixture({ ...usage, usedTokens: 280_000, percentage: 109 })
