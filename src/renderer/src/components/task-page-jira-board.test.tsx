import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraProjectStatusOrder, JiraStatus } from '../../../shared/types'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null
}))

const { TaskPageJiraBoard, jiraBoardIssueRefKey } = await import('./task-page-jira-board')

function status(id: string, name: string): JiraStatus {
  return { id, name, categoryKey: 'indeterminate', categoryName: 'In Progress' }
}

function issue(key: string, statusValue: JiraStatus): JiraIssue {
  return {
    id: key,
    key,
    title: `Title for ${key}`,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'p1', key: 'STA', name: 'Stably' },
    issueType: { id: 't1', name: 'Task' },
    status: statusValue,
    labels: ['backend'],
    updatedAt: '2026-08-07T12:00:00.000Z',
    createdAt: '2026-08-07T12:00:00.000Z'
  }
}

describe('TaskPageJiraBoard', () => {
  const todo = status('1', 'To Do')
  const done = status('3', 'Done')

  function renderBoard(
    issues: JiraIssue[],
    statusOrder: JiraProjectStatusOrder | null = null
  ): string {
    return renderToStaticMarkup(
      <TaskPageJiraBoard
        formatUpdatedAt={() => '2d'}
        getStatusTone={() => 'tone-class'}
        issues={issues}
        onMoveIssue={async () => {}}
        onOpenIssue={() => {}}
        onStartWorkspace={() => {}}
        selectedIssue={null}
        showSiteContext={false}
        statusOrder={statusOrder}
        updatingIssueKeys={new Set()}
      />
    )
  }

  it('renders one column per status with its issues as draggable cards', () => {
    const markup = renderBoard([issue('STA-1', todo), issue('STA-2', done), issue('STA-3', todo)])
    expect(markup).toContain('To Do')
    expect(markup).toContain('Done')
    expect(markup).toContain('Title for STA-1')
    expect(markup).toContain('Title for STA-3')
    expect((markup.match(/draggable="true"/g) ?? []).length).toBe(3)
  })

  it('lays lanes out on one horizontally scrollable row', () => {
    const markup = renderBoard([issue('STA-1', todo), issue('STA-2', done)])
    expect(markup).toContain('overflow-x-auto')
    expect((markup.match(/w-72 shrink-0/g) ?? []).length).toBe(2)
  })

  it('renders empty board columns with a drop placeholder', () => {
    const markup = renderBoard([issue('STA-1', todo)], {
      statusIdsByColumn: [['1'], ['3']],
      columns: [
        { name: 'To Do', statusIds: ['1'] },
        { name: 'Done', statusIds: ['3'] }
      ]
    })
    expect((markup.match(/w-72 shrink-0/g) ?? []).length).toBe(2)
    expect(markup).toContain('No issues')
  })

  it('orders columns by the project board status order', () => {
    const markup = renderBoard([issue('STA-1', todo), issue('STA-2', done)], {
      statusIdsByColumn: [['3'], ['1']]
    })
    expect(markup.indexOf('Done')).toBeLessThan(markup.indexOf('To Do'))
  })

  it('marks updating cards as disabled for dragging', () => {
    const updating = issue('STA-9', todo)
    const markup = renderToStaticMarkup(
      <TaskPageJiraBoard
        formatUpdatedAt={() => '2d'}
        getStatusTone={() => 'tone-class'}
        issues={[updating]}
        onMoveIssue={async () => {}}
        onOpenIssue={() => {}}
        onStartWorkspace={() => {}}
        selectedIssue={null}
        showSiteContext={false}
        statusOrder={null}
        updatingIssueKeys={new Set([jiraBoardIssueRefKey(updating)])}
      />
    )
    expect(markup).toContain('draggable="false"')
    expect(markup).toContain('aria-disabled="true"')
  })
})
