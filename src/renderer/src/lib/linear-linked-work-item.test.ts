import { describe, expect, it } from 'vitest'

import type { LinearIssue } from '../../../shared/types'
import { buildLinearIssueLinkedWorkItem } from './linear-linked-work-item'

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
  it('preserves Linear metadata and attaches rendered context', () => {
    const item = buildLinearIssueLinkedWorkItem(makeIssue(), 'Identifier: ENG-123')

    expect(item).toMatchObject({
      type: 'issue',
      number: 0,
      title: 'Fix launch context handoff',
      url: 'https://linear.app/acme/issue/ENG-123/fix-launch-context-handoff',
      linearIdentifier: 'ENG-123',
      linkedContext: {
        provider: 'linear',
        version: 1,
        renderedText: 'Identifier: ENG-123'
      }
    })
  })

  it('omits empty linked context while keeping the Linear identifier', () => {
    const item = buildLinearIssueLinkedWorkItem(makeIssue(), '   ')

    expect(item.linearIdentifier).toBe('ENG-123')
    expect(item.linkedContext).toBeUndefined()
  })

  it('builds a default snapshot when rendered text is not supplied', () => {
    const item = buildLinearIssueLinkedWorkItem(makeIssue())

    expect(item.linkedContext?.renderedText).toContain('Linear issue context snapshot')
    expect(item.linkedContext?.renderedText).toContain('Identifier: ENG-123')
  })
})
