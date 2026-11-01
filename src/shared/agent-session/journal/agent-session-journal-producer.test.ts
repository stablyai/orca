import { describe, expect, it } from 'vitest'
import {
  agentJournalLinkageFields,
  isRootAgentJournalItem
} from '../../agent-session-journal-producer'

describe('isRootAgentJournalItem', () => {
  it('reads an id that failed to resolve as a subagent’s, not as root', () => {
    // Presence, not truthiness: an unresolved child id must never attribute its content to the parent.
    expect(isRootAgentJournalItem({ agentId: '' })).toBe(false)
  })
})

describe('agentJournalLinkageFields', () => {
  it('omits absent members rather than writing them as undefined', () => {
    // An own key set to undefined is still present; absence alone claims root.
    expect(agentJournalLinkageFields({ agentId: 'task-1' })).toEqual({ agentId: 'task-1' })
    expect(Object.keys(agentJournalLinkageFields({ agentId: 'task-1' }))).toEqual(['agentId'])
    expect(agentJournalLinkageFields(undefined)).toEqual({})
  })
})
