import React from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { TaskPageJiraBoard } from '../../../src/renderer/src/components/task-page-jira-board'
import { getJiraStatusTone } from '../../../src/renderer/src/components/task-page-jira-status-tone'
import type { JiraIssue, JiraProjectStatusOrder, JiraStatus } from '../../../src/shared/jira-types'
import './fixture.css'

const statusOrder: JiraProjectStatusOrder = {
  statusIdsByColumn: [['10001'], ['10002'], ['10003']],
  columns: [
    { name: 'To Do', statusIds: ['10001'] },
    { name: 'In Progress', statusIds: ['10002'] },
    { name: 'Done', statusIds: ['10003'] }
  ]
}

const statuses = {
  todo: { id: '10001', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
  doing: {
    id: '10002',
    name: 'In Progress',
    categoryKey: 'indeterminate',
    categoryName: 'In Progress'
  },
  done: { id: '10003', name: 'Done', categoryKey: 'done', categoryName: 'Done' }
}

// Invented sample data. No real site, project, person, or issue appears here.
function sampleIssue(
  key: string,
  title: string,
  status: JiraStatus,
  priority: string,
  updated: string
): JiraIssue {
  return {
    id: `id-${key}`,
    key,
    title,
    url: `https://example.invalid/browse/${key}`,
    project: { id: 'p1', key: 'DEMO', name: 'Demo' },
    issueType: { id: 't1', name: 'Task' },
    status,
    labels: [],
    priority: { id: `pr-${priority}`, name: priority },
    assignee: { accountId: 'a1', displayName: 'Sample User' },
    updatedAt: updated,
    createdAt: updated
  }
}

const issues: JiraIssue[] = [
  sampleIssue(
    'DEMO-104',
    'Paginate the export history table',
    statuses.doing,
    'High',
    '3 hours ago'
  ),
  sampleIssue(
    'DEMO-101',
    'Cache the colour palette between launches',
    statuses.doing,
    'Medium',
    '1 day ago'
  ),
  sampleIssue('DEMO-112', 'Retry the webhook delivery once', statuses.todo, 'Medium', '2 days ago'),
  sampleIssue('DEMO-108', 'Document the import file format', statuses.todo, 'Low', '3 days ago'),
  sampleIssue('DEMO-93', 'Collapse duplicate toast messages', statuses.done, 'Medium', '6 days ago')
]

function App(): React.JSX.Element {
  return (
    <TooltipProvider>
      <main className="bg-background p-6 text-foreground">
        <div className="overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
          <div className="flex h-10 items-center border-b border-border/50 bg-muted/35 px-3 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Jira issues
          </div>
          <TaskPageJiraBoard
            columnOrderScopeKey="fixture-board"
            formatUpdatedAt={(updatedAt) => updatedAt}
            getStatusTone={getJiraStatusTone}
            issues={issues}
            onMoveIssue={async () => {}}
            onOpenIssue={() => {}}
            onStartWorkspace={() => {}}
            selectedIssue={null}
            showSiteContext={false}
            statusOrder={statusOrder}
            updatingIssueKeys={new Set()}
          />
        </div>
      </main>
    </TooltipProvider>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<App />)
}
