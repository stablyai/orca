import { describe, expect, it } from 'vitest'

import type { LinearIssue } from '../../../shared/types'
import { buildLinearIssueBranchName } from './linear-issue-workspace-text'

function makeIssue(branchName?: string): LinearIssue {
  return {
    id: 'issue-1',
    identifier: 'ENG-123',
    title: 'Fix launch context handoff',
    url: 'https://linear.app/acme/issue/ENG-123/fix-launch-context-handoff',
    branchName,
    state: { name: 'Todo', type: 'unstarted', color: '#999999' },
    team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
    labels: [],
    labelIds: [],
    priority: 3,
    estimate: null,
    updatedAt: '2026-05-29T12:00:00.000Z'
  }
}

describe('buildLinearIssueBranchName', () => {
  it('prefers Linear’s branch name', () => {
    expect(buildLinearIssueBranchName(makeIssue('  team/eng-123-fix-launch-context  '))).toBe(
      'team/eng-123-fix-launch-context'
    )
  })

  it('falls back to Orca’s generated workspace slug', () => {
    expect(buildLinearIssueBranchName(makeIssue())).toBe('eng-123-fix-launch-context-handoff')
    expect(buildLinearIssueBranchName(makeIssue('   '))).toBe('eng-123-fix-launch-context-handoff')
  })
})
