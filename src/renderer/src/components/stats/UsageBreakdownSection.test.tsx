// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageBreakdownSection } from './UsageBreakdownSection'

afterEach(cleanup)

describe('UsageBreakdownSection', () => {
  it('wraps long model identifiers instead of truncating them', () => {
    const firstModel = 'fireworks-ai/accounts/fireworks/models/deepseek-v3p2'
    const secondModel = 'fireworks-ai/accounts/fireworks/models/qwen3-coder-480b'

    render(
      <UsageBreakdownSection
        title="By model"
        topLabel="Top model:"
        topValue={firstModel}
        eventsOrTurns="events"
        rows={[
          { key: firstModel, label: firstModel, tokens: 1_000, sessions: 1, eventsOrTurns: 2 },
          { key: secondModel, label: secondModel, tokens: 2_000, sessions: 2, eventsOrTurns: 4 }
        ]}
      />
    )

    for (const model of [firstModel, secondModel]) {
      const label = screen.getByText(model)
      expect(label).toHaveClass('min-w-0', 'break-words')
      expect(label).not.toHaveClass('truncate')
    }
  })
})
