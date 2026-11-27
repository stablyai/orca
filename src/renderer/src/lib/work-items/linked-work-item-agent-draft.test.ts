import { describe, expect, it } from 'vitest'
import { appendAgentLaunchDraft } from './linked-work-item-context'

describe('appendAgentLaunchDraft', () => {
  it('leaves the linked draft alone without an agent draft', () => {
    expect(appendAgentLaunchDraft('note\n\nhttps://example.com/1', '   ')).toBe(
      'note\n\nhttps://example.com/1'
    )
    expect(appendAgentLaunchDraft(null, undefined)).toBeNull()
  })

  it('drafts the agent prompt alone or after the linked draft', () => {
    expect(appendAgentLaunchDraft(null, '  Implement the plan.  ')).toBe('Implement the plan.\n')
    expect(appendAgentLaunchDraft('note\n\nhttps://example.com/1\n', 'Implement the plan.')).toBe(
      'note\n\nhttps://example.com/1\n\nImplement the plan.\n'
    )
  })
})
