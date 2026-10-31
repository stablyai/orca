import { describe, expect, it } from 'vitest'
import { getLinearIssueDisplayLabels } from './linear-issue-display-labels'

describe('getLinearIssueDisplayLabels', () => {
  it('colors same-named labels by id and leaves drifted labels plain', () => {
    expect(
      getLinearIssueDisplayLabels({
        labels: ['Frontend', 'Frontend', 'Bug'],
        labelIds: ['team-frontend', 'workspace-frontend', 'stale-id'],
        labelDetails: [
          { id: 'workspace-frontend', name: 'Frontend', color: '#4ea7fc' },
          { id: 'team-frontend', name: 'Frontend', color: '#bb87fc' },
          { id: 'stale-id', name: 'Feature', color: '#4cb782' }
        ]
      })
    ).toEqual([
      { id: 'team-frontend', name: 'Frontend', color: '#bb87fc' },
      { id: 'workspace-frontend', name: 'Frontend', color: '#4ea7fc' },
      { name: 'Bug' }
    ])
  })

  it('keeps label ids when an older runtime sends no label details', () => {
    expect(
      getLinearIssueDisplayLabels({
        labels: ['Frontend', 'Frontend'],
        labelIds: ['team-frontend', 'workspace-frontend']
      })
    ).toEqual([
      { id: 'team-frontend', name: 'Frontend' },
      { id: 'workspace-frontend', name: 'Frontend' }
    ])
  })
})
