import type { LinearIssue, LinearIssueChildSummary } from '../../../shared/linear/issue-types'
import { defineFixture } from '../component-fixtures/component-fixture'
import { LinearIssueSubIssues } from './linear-issue-sub-issues'
import {
  saveLinearSubIssueViewOptions,
  type LinearSubIssueViewOptions
} from './linear-sub-issue-view-options'

function subIssue(
  number: number,
  title: string,
  state?: LinearIssueChildSummary['state'],
  fields?: Pick<LinearIssueChildSummary, 'priority' | 'subIssueSortOrder'>
): LinearIssueChildSummary {
  return {
    id: `sub-${number}`,
    identifier: `ENG-${number}`,
    title,
    url: `https://linear.app/example/issue/ENG-${number}`,
    state,
    ...fields
  }
}

const DEFAULT_VIEW: LinearSubIssueViewOptions = { orderBy: 'manual', showCompleted: true }

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
  setup: () => saveLinearSubIssueViewOptions(DEFAULT_VIEW),
  render: () => <LinearIssueSubIssues issue={parentIssue} onOpenIssue={() => {}} />
})

export const longText = defineFixture({
  width: 420,
  setup: () => saveLinearSubIssueViewOptions(DEFAULT_VIEW),
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

const sprintIssue: LinearIssue = {
  ...parentIssue,
  subIssues: [
    subIssue(
      301,
      'Write the migration plan',
      { name: 'Done', type: 'completed', color: '#5e6ad2', position: 0 },
      { priority: 2, subIssueSortOrder: 0 }
    ),
    subIssue(
      302,
      'Ship the new billing page',
      { name: 'In Progress', type: 'started', color: '#f2c94c', position: 1 },
      { priority: 1, subIssueSortOrder: 1 }
    ),
    subIssue(
      303,
      'Audit unused feature flags',
      { name: 'Backlog', type: 'backlog', color: '#bec2c8', position: 0 },
      { priority: 4, subIssueSortOrder: 2 }
    ),
    subIssue(
      304,
      'Fix the invoice rounding bug',
      { name: 'In Review', type: 'started', color: '#0f783c', position: 2 },
      { priority: 1, subIssueSortOrder: 3 }
    ),
    subIssue(
      305,
      'Update the pricing FAQ',
      { name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 0 },
      { priority: 3, subIssueSortOrder: 4 }
    ),
    subIssue(
      306,
      'Retire the old checkout flow',
      { name: 'Canceled', type: 'canceled', color: '#95a2b3', position: 0 },
      { priority: 0, subIssueSortOrder: 5 }
    )
  ]
}

function SprintSubIssues(): React.JSX.Element {
  return <LinearIssueSubIssues issue={sprintIssue} onOpenIssue={() => {}} />
}

export const displayOptionsMenu = defineFixture({
  width: 640,
  setup: () => saveLinearSubIssueViewOptions(DEFAULT_VIEW),
  render: () => <SprintSubIssues />,
  interact: async (frame) => {
    frame
      .querySelector<HTMLButtonElement>('button[aria-label="Sub-issue display options"]')
      ?.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerType: 'mouse'
        })
      )
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
})

export const orderedByStatus = defineFixture({
  width: 640,
  setup: () => saveLinearSubIssueViewOptions({ orderBy: 'status', showCompleted: true }),
  render: () => <SprintSubIssues />
})

export const completedHidden = defineFixture({
  width: 640,
  setup: () => saveLinearSubIssueViewOptions({ orderBy: 'manual', showCompleted: false }),
  render: () => <SprintSubIssues />
})
