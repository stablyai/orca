import { selectStructuredAgentContextUsage } from '../../../../shared/structured-agent-session-context-usage'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatContextUsageRing } from './NativeChatContextUsageRing'
import { summarizeContextUsage } from './native-chat-context-usage-summary'

function ReportedContext({ model }: { model: string }) {
  const usage = selectStructuredAgentContextUsage([], {
    used: {
      kind: 'report',
      model,
      usedTokens: 39_235,
      windowTokens: 258_400,
      percentage: 15,
      categories: [],
      capturedAt: 1
    }
  })
  if (!usage) {
    throw new Error('Expected reported context usage')
  }
  return (
    <div className="flex h-64 items-end justify-end p-4">
      <NativeChatContextUsageRing usage={summarizeContextUsage(usage)} />
    </div>
  )
}

export const unknownModel = defineFixture({
  width: 360,
  render: () => <ReportedContext model="unknown" />,
  interact: (frame) => frame.querySelector<HTMLButtonElement>('button')?.click()
})

export const knownModel = defineFixture({
  width: 360,
  render: () => <ReportedContext model="gpt-6-astra" />,
  interact: (frame) => frame.querySelector<HTMLButtonElement>('button')?.click()
})
