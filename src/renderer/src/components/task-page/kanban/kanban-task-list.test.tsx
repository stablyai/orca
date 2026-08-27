// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { KanbanTaskDetails, KanbanTaskSummary } from '../../../../../shared/kanban-types'
import { KanbanTaskDetail } from './kanban-task-detail'
import { KanbanTaskList } from './kanban-task-list'

const summaryFixture: KanbanTaskSummary = {
  id: 't1',
  title: 'Task one',
  laneId: 'lane-open',
  laneName: 'Открыто',
  due: '2026-08-28',
  urgent: false,
  repositoryUrls: ['https://example.com/org/repo'],
  taskVersion: 1,
  executors: [{ id: 'u1', name: 'User One' }],
  observers: [{ id: 'u2', name: 'User Two' }],
  createdBy: { id: 'u3', name: 'User Three' },
  url: 'https://kanban.fpimi.ru/?task=t1'
}

const detailsFixture: KanbanTaskDetails = {
  ...summaryFixture,
  result: 'Expected result text',
  description: 'Expected description text',
  tags: ['backend'],
  source: 'https://example.com/org/repo',
  comments: [
    {
      id: 'c1',
      author: { id: 'u2', name: 'User Two' },
      text: 'Comment text',
      createdAt: '2026-08-20T10:00:00.000Z'
    }
  ],
  blockedBy: ['t9'],
  attachments: [{ name: 'report.pdf', url: 'https://example.com/report.pdf', size: 1024 }],
  subtasks: []
}

let container: HTMLDivElement | null = null
let root: Root | null = null
const openUrlMock = vi.fn()

function render(element: React.JSX.Element): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  container = host
  root = createRoot(host)
  void act(() => {
    root?.render(<TooltipProvider>{element}</TooltipProvider>)
  })
  return host
}

beforeEach(() => {
  openUrlMock.mockReset().mockResolvedValue(undefined)
  globalThis.window.api = {
    shell: { openUrl: openUrlMock }
  } as never
})

afterEach(() => {
  root?.unmount()
  root = null
  container?.remove()
  container = null
})

describe('KanbanTaskList', () => {
  it('renders the Kanban source name accessibly', () => {
    const host = render(
      <KanbanTaskList
        tasks={[summaryFixture]}
        selectedTaskId={null}
        onOpenDetail={() => undefined}
        onStartWorkspace={() => undefined}
      />
    )
    expect(host.querySelector('[aria-label="Kanban tasks"]')).not.toBeNull()
    expect(host.textContent).toContain('Task one')
  })

  it('renders the row id, lane, due, urgent marker and repository', () => {
    const host = render(
      <KanbanTaskList
        tasks={[summaryFixture]}
        selectedTaskId={null}
        onOpenDetail={() => undefined}
        onStartWorkspace={() => undefined}
      />
    )
    expect(host.textContent).toContain('t1')
    expect(host.textContent).toContain('Открыто')
    expect(host.textContent).toContain('example.com/org/repo')
  })

  it('rows are keyboard focusable and open the detail on Enter', () => {
    const onOpenDetail = vi.fn()
    const host = render(
      <KanbanTaskList
        tasks={[summaryFixture]}
        selectedTaskId={null}
        onOpenDetail={onOpenDetail}
        onStartWorkspace={() => undefined}
      />
    )
    const row = host.querySelector('[role="listitem"][tabindex="0"]')
    expect(row).not.toBeNull()
    void act(() => {
      row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onOpenDetail).toHaveBeenCalledWith(summaryFixture)
  })

  it('row Start button starts the workspace', () => {
    const onStartWorkspace = vi.fn()
    const host = render(
      <KanbanTaskList
        tasks={[summaryFixture]}
        selectedTaskId={null}
        onOpenDetail={() => undefined}
        onStartWorkspace={onStartWorkspace}
      />
    )
    const startButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.getAttribute('aria-label')?.includes('Start')
    )
    expect(startButton).not.toBeNull()
    void act(() => {
      startButton?.click()
    })
    expect(onStartWorkspace).toHaveBeenCalledWith(summaryFixture)
  })

  it('deep link opens the task in the browser', () => {
    const host = render(
      <KanbanTaskList
        tasks={[summaryFixture]}
        selectedTaskId={null}
        onOpenDetail={() => undefined}
        onStartWorkspace={() => undefined}
      />
    )
    const linkButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.getAttribute('aria-label')?.includes('browser')
    )
    void act(() => {
      linkButton?.click()
    })
    expect(openUrlMock).toHaveBeenCalledWith('https://kanban.fpimi.ru/?task=t1')
  })
})

describe('KanbanTaskDetail', () => {
  it('renders read-only detail fields and a browser deep link', () => {
    const host = render(<KanbanTaskDetail task={detailsFixture} onClose={() => undefined} />)
    expect(host.textContent).toContain('Expected result text')
    expect(host.textContent).toContain('Expected description text')
    expect(host.textContent).toContain('User One')
    expect(host.textContent).toContain('User Two')
    expect(host.textContent).toContain('User Three')
    expect(host.textContent).toContain('Comment text')
    expect(host.textContent).toContain('t9')
    expect(host.textContent).toContain('report.pdf')
    expect(host.textContent).toContain('example.com/org/repo')
  })

  it('exposes no editable fields', () => {
    const host = render(<KanbanTaskDetail task={detailsFixture} onClose={() => undefined} />)
    expect(host.querySelector('input')).toBeNull()
    expect(host.querySelector('textarea')).toBeNull()
    expect(host.querySelector('[contenteditable="true"]')).toBeNull()
  })

  it('deep link button opens the card in the browser', () => {
    const host = render(<KanbanTaskDetail task={detailsFixture} onClose={() => undefined} />)
    const linkButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.getAttribute('aria-label')?.includes('browser')
    )
    expect(linkButton).not.toBeNull()
    void act(() => {
      linkButton?.click()
    })
    expect(openUrlMock).toHaveBeenCalledWith('https://kanban.fpimi.ru/?task=t1')
  })
})
