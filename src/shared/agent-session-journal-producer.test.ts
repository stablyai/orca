import { describe, expect, it } from 'vitest'
import { agentJournalLinkageFields, isRootAgentJournalItem } from './agent-session-journal-producer'

describe('isRootAgentJournalItem', () => {
  it("reads a row carrying no agent id as the session's own", () => {
    expect(isRootAgentJournalItem({})).toBe(true)
  })

  it('reads a row carrying one as a subagent’s', () => {
    expect(isRootAgentJournalItem({ agentId: 'task-1' })).toBe(false)
  })

  it('reads an id that failed to resolve as a subagent’s, not as root', () => {
    // Presence, not truthiness. This is the whole point of the predicate: a
    // truthy test answers "root" here, which puts the child's content back on
    // the parent — the defect this attribution exists to remove.
    expect(isRootAgentJournalItem({ agentId: '' })).toBe(false)
  })

  it('reads a missing item as root rather than throwing', () => {
    // Every caller walks a list backwards with an index that can fall off it.
    expect(isRootAgentJournalItem(undefined)).toBe(true)
  })
})

describe('agentJournalLinkageFields', () => {
  it('omits absent members rather than writing them as undefined', () => {
    // Absence is the claim these fields make, so a key present with an
    // undefined value is not the same statement as no key at all.
    expect(agentJournalLinkageFields({ agentId: 'task-1' })).toEqual({ agentId: 'task-1' })
    expect(agentJournalLinkageFields(undefined)).toEqual({})
  })

  it('carries every member of the bundle through', () => {
    const linkage = {
      agentId: 'task-1',
      parentAgentId: 'task-parent',
      providerParentRef: 'toolu_1',
      producerKind: 'background' as const,
      attempt: 3
    }
    expect(agentJournalLinkageFields(linkage)).toEqual(linkage)
  })
})
