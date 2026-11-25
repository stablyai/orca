import { defineFixture } from '../../component-fixtures/component-fixture'
import { ClaudeUsageDailyChart } from './ClaudeUsageDailyChart'
import { CodexUsageDailyChart } from './CodexUsageDailyChart'

const daily = Array.from({ length: 10 }, (_, index) => ({
  day: `2026-11-${String(index + 7).padStart(2, '0')}`,
  inputTokens: 40_000 + index * 9_000,
  outputTokens: 120_000 + ((index * 37_000) % 160_000),
  cacheReadTokens: 6_000_000 + ((index * 1_900_000) % 9_000_000),
  cacheWriteTokens: 400_000 + ((index * 210_000) % 700_000)
}))

const clickLegend = (index: number) => (frame: HTMLElement) => {
  frame.querySelectorAll('button')[index]?.click()
}

export const allTypes = defineFixture({
  width: 720,
  render: () => <ClaudeUsageDailyChart daily={daily} />
})

export const cacheReadHidden = defineFixture({
  width: 720,
  render: () => <ClaudeUsageDailyChart daily={daily} />,
  interact: clickLegend(2)
})

export const codexAllTypes = defineFixture({
  width: 720,
  render: () => (
    <CodexUsageDailyChart
      reasoningIncludedInOutput
      daily={daily.map((entry) => ({
        day: entry.day,
        inputTokens: entry.cacheReadTokens / 4 + entry.inputTokens,
        cachedInputTokens: entry.cacheReadTokens / 4,
        outputTokens: entry.outputTokens,
        reasoningOutputTokens: Math.round(entry.outputTokens / 3),
        totalTokens: entry.cacheReadTokens / 4 + entry.inputTokens + entry.outputTokens
      }))}
    />
  )
})
