import type { LinearIssue, LinearIssueChildSummary } from '../../../shared/linear/issue-types'
import { defineFixture } from '../component-fixtures/component-fixture'
import { LinearIssueSubIssues } from './linear-issue-sub-issues'

function subIssue(
  number: number,
  title: string,
  state?: LinearIssueChildSummary['state']
): LinearIssueChildSummary {
  return {
    id: `sub-${number}`,
    identifier: `ENG-${number}`,
    title,
    url: `https://linear.app/example/issue/ENG-${number}`,
    state
  }
}

const parentIssue: LinearIssue = {
  id: 'parent',
  identifier: 'ENG-100',
  title: 'Onboarding revamp',
  url: 'https://linear.app/example/issue/ENG-100',
  state: { name: 'In Progress', type: 'started', color: '#f2c94c' },
  team: { id: 'team', name: 'Engineering', key: 'ENG' },
  labels: [],
  labelIds: [],
  priority: 0,
  updatedAt: '2026-01-01T00:00:00.000Z',
  subIssues: [
    subIssue(101, 'Draft the welcome email copy', {
      name: 'Backlog',
      type: 'backlog',
      color: '#bec2c8'
    }),
    subIssue(102, 'Add a progress bar to the setup wizard', {
      name: 'Todo',
      type: 'unstarted',
      color: '#e2e2e2'
    }),
    subIssue(103, 'Track wizard completion in analytics', {
      name: 'In Progress',
      type: 'started',
      color: '#f2c94c'
    }),
    subIssue(104, 'Polish the empty state illustrations', {
      name: 'In Review',
      type: 'started',
      color: '#0f783c'
    }),
    subIssue(105, 'Remove the legacy tour', { name: 'Done', type: 'completed', color: '#5e6ad2' }),
    subIssue(106, 'Localize the wizard', { name: 'Canceled', type: 'canceled', color: '#95a2b3' }),
    subIssue(107, 'Sub-issue created in Orca before refresh')
  ]
}

export const withStates = defineFixture({
  width: 640,
  render: () => <LinearIssueSubIssues issue={parentIssue} onOpenIssue={() => {}} />
})

export const longText = defineFixture({
  width: 420,
  render: () => (
    <LinearIssueSubIssues
      issue={{
        ...parentIssue,
        subIssues: [
          subIssue(
            201,
            'Investigate why the onboarding wizard skips the workspace invite step on slow networks',
            { name: 'In Progress', type: 'started', color: '#f2c94c' }
          ),
          subIssue(202, 'Short title', {
            name: 'Waiting for design and product sign-off',
            type: 'started',
            color: '#0f783c'
          }),
          subIssue(
            203,
            'Both the title and the custom workflow state name are long enough to overflow',
            {
              name: 'Blocked by an upstream platform dependency',
              type: 'started',
              color: '#eb5757'
            }
          )
        ]
      }}
      onOpenIssue={() => {}}
    />
  )
})
