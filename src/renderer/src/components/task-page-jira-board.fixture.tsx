import { defineFixture } from '../component-fixtures/component-fixture'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import { TaskPageJiraBoard } from './task-page-jira-board'
import { saveJiraBoardLaneOrder } from './task-page-jira-board-lane-order'

const STATUSES = ['To Do', 'In Progress', 'Pull Request', 'In QA', 'Ready to Merge']

// No board config: a project with several boards falls back to alphabetical status lanes.
const issues: JiraIssue[] = STATUSES.map((name, index) => ({
  id: String(index),
  key: `STA-${index + 1}`,
  title: `Issue in ${name}`,
  url: `https://example.atlassian.net/browse/STA-${index + 1}`,
  project: { id: 'p1', key: 'STA', name: 'Stably' },
  issueType: { id: 't1', name: 'Task' },
  status: { id: String(index), name, categoryKey: 'indeterminate', categoryName: 'In Progress' },
  labels: [],
  updatedAt: '2026-10-27T12:00:00.000Z',
  createdAt: '2026-10-27T12:00:00.000Z'
}))

function Board(): React.JSX.Element {
  return (
    <TaskPageJiraBoard
      formatUpdatedAt={() => '2d'}
      issues={issues}
      onMoveIssue={async () => {}}
      onOpenIssue={() => {}}
      onStartWorkspace={() => {}}
      selectedIssue={null}
      showSiteContext={false}
      statusOrder={null}
      updatingIssueKeys={new Set()}
    />
  )
}

export const defaultOrder = defineFixture({
  width: 1560,
  setup: () => saveJiraBoardLaneOrder([]),
  render: () => <Board />
})

export const savedOrder = defineFixture({
  width: 1560,
  setup: () => saveJiraBoardLaneOrder(STATUSES.map((name) => name.toLowerCase())),
  render: () => <Board />
})

export const laneMenu = defineFixture({
  width: 1560,
  setup: () => saveJiraBoardLaneOrder(STATUSES.map((name) => name.toLowerCase())),
  render: () => <Board />,
  interact: (frame) => {
    const trigger = frame.querySelector<HTMLButtonElement>(
      '[aria-label="Lane actions for In Progress"]'
    )
    trigger?.focus()
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
})
