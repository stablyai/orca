import { describe, expect, it } from 'vitest'
import { resolveAgentThroughputPlaceholderReason } from './agent-throughput-placeholder'

describe('resolveAgentThroughputPlaceholderReason', () => {
  it('explains why no reading is shown', () => {
    expect(resolveAgentThroughputPlaceholderReason({ paneKey: null, agentType: 'claude' })).toBe(
      'no-pane'
    )
    expect(
      resolveAgentThroughputPlaceholderReason({ paneKey: 'tab:leaf', agentType: 'kimi' })
    ).toBe('unmeasured-agent')
    expect(
      resolveAgentThroughputPlaceholderReason({ paneKey: 'tab:leaf', agentType: 'claude' })
    ).toBe('waiting')
    expect(
      resolveAgentThroughputPlaceholderReason({ paneKey: 'tab:leaf', agentType: undefined })
    ).toBe('waiting')
  })
})
