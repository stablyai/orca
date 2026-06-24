import { describe, expect, it } from 'vitest'

import type { LinearIssue } from '../../../shared/types'
import { buildLinearIssueLinkedWorkItem, isLinearLinkedWorkItem } from './linear-linked-work-item'

function makeIssue(patch: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'issue-1',
    identifier: 'ENG-123',
    title: 'Fix launch context handoff',
    description: 'Pass Linear issue details into the agent.',
    url: 'https://linear.app/acme/issue/ENG-123/fix-launch-context-handoff',
    state: { name: 'Todo', type: 'unstarted', color: '#999999' },
    team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
    labels: [],
    labelIds: [],
    priority: 3,
    estimate: null,
    updatedAt: '2026-05-29T12:00:00.000Z',
    ...patch
  }
}

describe('buildLinearIssueLinkedWorkItem', () => {
  it('preserves Linear metadata without attaching prompt-time issue context', () => {
    const item = buildLinearIssueLinkedWorkItem(makeIssue())

    expect(item).toMatchObject({
      type: 'issue',
      provider: 'linear',
      number: 0,
      title: 'Fix launch context handoff',
      url: 'https://linear.app/acme/issue/ENG-123/fix-launch-context-handoff',
      linearIdentifier: 'ENG-123',
      linearOrganizationUrlKey: 'acme'
    })
    expect(item).not.toHaveProperty('linkedContext')
  })

  it('carries the Linear workspace id when the issue has one', () => {
    const item = buildLinearIssueLinkedWorkItem(makeIssue({ workspaceId: 'ws-1' }))

    expect(item.linearWorkspaceId).toBe('ws-1')
  })
})

describe('isLinearLinkedWorkItem', () => {
  it('recognizes Linear-linked composer sources by provider or identifier', () => {
    expect(isLinearLinkedWorkItem(buildLinearIssueLinkedWorkItem(makeIssue()))).toBe(true)
    expect(isLinearLinkedWorkItem({ provider: 'linear' })).toBe(true)
    expect(isLinearLinkedWorkItem({ linearIdentifier: '   ' })).toBe(false)
    expect(isLinearLinkedWorkItem({})).toBe(false)
    expect(isLinearLinkedWorkItem(null)).toBe(false)
  })
})
