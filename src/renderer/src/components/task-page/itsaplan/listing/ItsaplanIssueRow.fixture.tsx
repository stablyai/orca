import type { ItsaplanIssue } from '../../../../../../shared/itsaplan/itsaplan-types'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ItsaplanIssueRow } from './ItsaplanIssueRow'

const baseIssue: ItsaplanIssue = {
  id: 4201,
  identifier: 'ENG-42',
  sequenceNumber: 42,
  projectRef: 'acme.ENG',
  title: 'Retry webhook deliveries with exponential backoff',
  description: '',
  priority: 'high',
  state: { columnId: 2, name: 'In progress', stateType: 'started' },
  labels: [
    { id: 1, name: 'backend', color: null },
    { id: 2, name: 'reliability', color: null },
    { id: 3, name: 'webhooks', color: null },
    { id: 4, name: 'q4', color: null }
  ],
  assignee: { userId: 'u1', name: 'Ada Lovelace', isAgent: false },
  delegate: null,
  parentId: null,
  url: 'https://plan.example.com/issue/4201',
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-25T10:00:00.000Z'
}

const issues: ItsaplanIssue[] = [
  baseIssue,
  {
    ...baseIssue,
    id: 4202,
    identifier: 'ENG-43',
    sequenceNumber: 43,
    title: 'Document the API key rotation flow',
    state: { columnId: 1, name: 'Todo', stateType: 'unstarted' },
    labels: [],
    assignee: null
  },
  {
    ...baseIssue,
    id: 4203,
    identifier: 'ENG-44',
    sequenceNumber: 44,
    title: 'Ship the project picker',
    state: { columnId: 3, name: 'Done', stateType: 'completed' },
    labels: [{ id: 5, name: 'ui', color: null }]
  }
]

function Rows(): React.JSX.Element {
  return (
    <div className="divide-y divide-border/50 bg-background">
      {issues.map((issue) => (
        <ItsaplanIssueRow key={issue.id} issue={issue} onOpen={() => {}} onStart={() => {}} />
      ))}
    </div>
  )
}

export const rows = defineFixture({ width: 1200, render: () => <Rows /> })
export const rowsNarrow = defineFixture({ width: 640, render: () => <Rows /> })
