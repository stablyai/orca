// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskPageJiraBoard } from './task-page-jira-board'
import type { JiraIssue, JiraProjectStatusOrder } from '../../../shared/jira/jira-types'

const statusOrder: JiraProjectStatusOrder = {
  statusIdsByColumn: [['todo'], ['doing'], ['done']],
  columns: [
    { name: 'To Do', statusIds: ['todo'] },
    { name: 'In Progress', statusIds: ['doing'] },
    { name: 'Done', statusIds: ['done'] }
  ]
}

function issue(key: string, statusId: string, statusName: string): JiraIssue {
  return {
    id: key,
    key,
    title: `Title for ${key}`,
    url: `https://example.invalid/browse/${key}`,
    project: { id: 'p1', key: 'ABC', name: 'Example' },
    issueType: { id: 'task', name: 'Task' },
    status: { id: statusId, name: statusName, categoryKey: 'new', categoryName: statusName },
    labels: [],
    updatedAt: '2026-10-01T12:00:00Z',
    createdAt: '2026-10-01T12:00:00Z'
  }
}

const issues = [
  issue('ABC-1', 'todo', 'To Do'),
  issue('ABC-2', 'doing', 'In Progress'),
  issue('ABC-3', 'done', 'Done')
]

function mount(scopeKey = 'scope-a'): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <TaskPageJiraBoard
        columnOrderScopeKey={scopeKey}
        formatUpdatedAt={() => '2d'}
        issues={issues}
        onMoveIssue={async () => {}}
        onOpenIssue={() => {}}
        onStartWorkspace={() => {}}
        selectedIssue={null}
        showSiteContext={false}
        statusOrder={statusOrder}
        updatingIssueKeys={new Set()}
      />
    </TooltipProvider>
  )
}

function laneOrder(): string[] {
  return screen
    .getAllByRole('button', { name: /^Reorder / })
    .map((handle) => handle.getAttribute('aria-label')?.replace('Reorder ', '') ?? '')
}

function dragLaneOnto(moved: string, target: string): void {
  const data = new Map<string, string>()
  const dataTransfer = {
    effectAllowed: 'none',
    dropEffect: 'none',
    setData: (format: string, value: string) => data.set(format, value),
    getData: (format: string) => data.get(format) ?? '',
    get types() {
      return [...data.keys()]
    }
  }
  fireEvent.dragStart(screen.getByRole('button', { name: `Reorder ${moved}` }), { dataTransfer })
  const targetHandle = screen.getByRole('button', { name: `Reorder ${target}` })
  fireEvent.dragOver(targetHandle, { dataTransfer })
  fireEvent.drop(targetHandle, { dataTransfer })
}

describe('Jira board column reordering', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(cleanup)

  it('starts in the order Jira configured the board', () => {
    mount()
    expect(laneOrder()).toEqual(['To Do', 'In Progress', 'Done'])
  })

  it('moves a dragged lane to where it was dropped', () => {
    mount()

    dragLaneOnto('Done', 'To Do')

    expect(laneOrder()).toEqual(['Done', 'To Do', 'In Progress'])
  })

  it('keeps the new order after the board is reopened', () => {
    mount()
    dragLaneOnto('Done', 'To Do')
    cleanup()

    mount()

    expect(laneOrder()).toEqual(['Done', 'To Do', 'In Progress'])
  })

  it('leaves another board scope on its own order', () => {
    mount('scope-a')
    dragLaneOnto('Done', 'To Do')
    cleanup()

    mount('scope-b')

    expect(laneOrder()).toEqual(['To Do', 'In Progress', 'Done'])
  })

  it('moves a lane with the arrow keys for keyboard users', () => {
    mount()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder To Do' }), { key: 'ArrowRight' })

    expect(laneOrder()).toEqual(['In Progress', 'To Do', 'Done'])
  })

  // The browser-accurate version of this runs in tests/tools/jira-board-column-order-rendered.
  it('keeps focus on the moved header so a second arrow press lands', () => {
    mount()
    const handle = screen.getByRole('button', { name: 'Reorder To Do' })
    handle.focus()

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reorder To Do' }))

    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder To Do' }), { key: 'ArrowRight' })
    expect(laneOrder()).toEqual(['In Progress', 'Done', 'To Do'])
  })

  it('ignores an arrow key that would move a lane past the end', () => {
    mount()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder To Do' }), { key: 'ArrowLeft' })

    expect(laneOrder()).toEqual(['To Do', 'In Progress', 'Done'])
  })

  it('keeps a lane that a filter hid in the place the user put it', () => {
    // A status outside the board config only gets a lane while an issue is in it.
    const blocked = issue('ABC-9', 'blocked', 'Blocked')
    const configured: JiraProjectStatusOrder = {
      statusIdsByColumn: [['todo'], ['doing']],
      columns: [
        { name: 'To Do', statusIds: ['todo'] },
        { name: 'In Progress', statusIds: ['doing'] }
      ]
    }
    const withBlocked = [issues[0], issues[1], blocked]
    const withoutBlocked = [issues[0], issues[1]]
    const board = (shown: JiraIssue[]): React.JSX.Element => (
      <TooltipProvider>
        <TaskPageJiraBoard
          columnOrderScopeKey="scope-a"
          formatUpdatedAt={() => '2d'}
          issues={shown}
          onMoveIssue={async () => {}}
          onOpenIssue={() => {}}
          onStartWorkspace={() => {}}
          selectedIssue={null}
          showSiteContext={false}
          statusOrder={configured}
          updatingIssueKeys={new Set()}
        />
      </TooltipProvider>
    )

    const { rerender } = render(board(withBlocked))
    expect(laneOrder()).toEqual(['To Do', 'In Progress', 'Blocked'])
    dragLaneOnto('Blocked', 'To Do')
    expect(laneOrder()).toEqual(['Blocked', 'To Do', 'In Progress'])

    // The filter drops the only Blocked issue, so that lane disappears; reorder the rest.
    rerender(board(withoutBlocked))
    dragLaneOnto('In Progress', 'To Do')
    expect(laneOrder()).toEqual(['In Progress', 'To Do'])

    rerender(board(withBlocked))

    expect(laneOrder()).toEqual(['Blocked', 'In Progress', 'To Do'])
  })

  it('still moves an issue when a card is dropped on another lane', async () => {
    const moved: string[] = []
    render(
      <TooltipProvider>
        <TaskPageJiraBoard
          columnOrderScopeKey="scope-a"
          formatUpdatedAt={() => '2d'}
          issues={issues}
          onMoveIssue={async (issue, section) => {
            moved.push(`${issue.key}->${section.label}`)
          }}
          onOpenIssue={() => {}}
          onStartWorkspace={() => {}}
          selectedIssue={null}
          showSiteContext={false}
          statusOrder={statusOrder}
          updatingIssueKeys={new Set()}
        />
      </TooltipProvider>
    )

    const data = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: (format: string, value: string) => data.set(format, value),
      getData: (format: string) => data.get(format) ?? '',
      get types() {
        return [...data.keys()]
      }
    }
    const card = screen.getByText('Title for ABC-1').closest('[draggable="true"]')
    if (!card) {
      throw new Error('expected the issue card to be draggable')
    }
    const lane = screen.getByRole('button', { name: 'Reorder Done' })
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.dragOver(lane, { dataTransfer })
    fireEvent.drop(lane, { dataTransfer })

    expect(moved).toEqual(['ABC-1->Done'])
    expect(laneOrder()).toEqual(['To Do', 'In Progress', 'Done'])
  })
})
