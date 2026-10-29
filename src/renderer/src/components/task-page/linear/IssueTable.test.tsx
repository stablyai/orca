// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskPageLinearIssueTable } from './IssueTable'
import type { LinearIssueListRow } from './task-page-linear-issue-model'

vi.mock('./task-page-linear-issue-model', () => ({ LinearStateCell: () => null }))

afterEach(cleanup)

function issue(id: string): LinearIssue {
  return {
    id,
    identifier: `COR-${id}`,
    title: `Issue ${id}`,
    url: `https://linear.app/core/issue/COR-${id}`,
    state: { name: 'Todo', type: 'unstarted', color: '#000' },
    team: { id: 'core', name: 'Core', key: 'COR' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-10-01T00:00:00Z'
  }
}

const first = issue('1')
const second = issue('2')
const third = issue('3')
const rows: LinearIssueListRow[] = [
  { type: 'section', key: 'status:Todo', label: 'Todo', count: 2 },
  { type: 'issue', issue: first },
  { type: 'issue', issue: second },
  { type: 'section', key: 'status:Done', label: 'Done', count: 1 },
  { type: 'issue', issue: third }
]

function table(linearIssueListRows = rows) {
  const fixture = {
    selectedLinearWorkspaceId: 'all',
    linearTaskSourceContext: null,
    selectedLinearIssueId: null,
    openLinearDetailPage: vi.fn(),
    linearIssueAttachmentIndex: new Map(),
    effectiveLinearDisplayProperties: new Set(),
    linearIssueGridStyle: {},
    linearIssueListRows,
    handleOpenOrUseLinearItem: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every model field read by this table.
  const model = fixture as unknown as TaskPageComposerActionsModel
  return (
    <TooltipProvider>
      <TaskPageLinearIssueTable model={model} />
    </TooltipProvider>
  )
}

it('collapses only the clicked section, keeps counts, and expands with Enter and Space', async () => {
  const user = userEvent.setup()
  render(table())
  const todo = screen.getByRole('button', { name: 'Todo 2', expanded: true })
  const done = screen.getByRole('button', { name: 'Done 1', expanded: true })
  await user.click(todo)
  expect(todo.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('Issue 1')).toBeNull()
  expect(screen.queryByText('Issue 2')).toBeNull()
  expect(screen.getByText('Issue 3')).toBeTruthy()
  expect(done.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('button', { name: 'Todo 2' })).toBe(todo)

  await user.keyboard('{Enter}')
  expect(todo.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('Issue 1')).toBeTruthy()
  expect(screen.getByText('Issue 2')).toBeTruthy()
  await user.keyboard(' ')
  expect(todo.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('Issue 1')).toBeNull()
  await user.click(todo)
  expect(screen.getByText('Issue 1')).toBeTruthy()
})

it('tracks the group key through refreshed rows and leaves ungrouped issues visible', async () => {
  const user = userEvent.setup()
  const view = render(table())
  await user.click(screen.getByRole('button', { name: 'Todo 2' }))
  const refreshed: LinearIssueListRow[] = [
    ...rows.slice(3),
    { type: 'section', key: 'status:Todo', label: 'Todo', count: 3 },
    ...rows.slice(1, 3),
    { type: 'issue', issue: issue('4') }
  ]
  view.rerender(table(refreshed))
  expect(screen.getByRole('button', { name: 'Todo 3', expanded: false })).toBeTruthy()
  expect(screen.queryByText('Issue 4')).toBeNull()
  expect(screen.getByText('Issue 3')).toBeTruthy()

  view.rerender(table([{ type: 'issue', issue: first }]))
  expect(screen.getByText('Issue 1')).toBeTruthy()
  view.unmount()
  render(table())
  expect(screen.getByRole('button', { name: 'Todo 2', expanded: true })).toBeTruthy()
})

it('bounds section-click work linearly at N and 10N remembered groups and current rows', () => {
  const samples = [1, 10].map((scale) => {
    const history = 100 * scale
    const groups = 3 * scale
    const operations = { copiedKeys: 0, membershipChecks: 0, rowVisits: 0 }
    function page(start: number, count: number): LinearIssueListRow[] {
      return Array.from({ length: count }, (_, offset) => {
        const id = start + offset
        return [
          {
            get type() {
              operations.rowVisits += 1
              return 'section' as const
            },
            key: `assignee:perf-${id}`,
            label: `Person ${id}`,
            count: 1
          },
          {
            get type() {
              operations.rowVisits += 1
              return 'issue' as const
            },
            issue: issue(`perf-${id}`)
          }
        ]
      }).flat()
    }
    const view = render(table([]))
    // Each page stays within the shipped 36-issue limit; absent keys remain in this mount.
    for (let start = 0; start < history; start += 36) {
      view.rerender(table(page(start, Math.min(36, history - start))))
      for (const button of view.container.querySelectorAll('button[aria-expanded]')) {
        fireEvent.click(button)
        expect(button.getAttribute('aria-expanded')).toBe('false')
      }
    }
    view.rerender(table(page(history, groups)))
    const button = screen.getByRole('button', { name: `Person ${history} 1` })
    const iterate = Set.prototype[Symbol.iterator]
    const has = Set.prototype.has
    const copied = vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function (
      this: Set<unknown>
    ) {
      const iterator = iterate.call(this)
      const next = iterator.next.bind(iterator)
      iterator.next = () => {
        const result = next()
        if (
          !result.done &&
          typeof result.value === 'string' &&
          result.value.startsWith('assignee:perf-')
        ) {
          operations.copiedKeys += 1
        }
        return result
      }
      return iterator
    })
    const membership = vi.spyOn(Set.prototype, 'has').mockImplementation(function (
      this: Set<unknown>,
      value: unknown
    ) {
      if (typeof value === 'string' && value.startsWith('assignee:perf-')) {
        operations.membershipChecks += 1
      }
      return has.call(this, value)
    })
    const clicks: (typeof operations)[] = []
    try {
      for (const expanded of [false, true]) {
        Object.assign(operations, { copiedKeys: 0, membershipChecks: 0, rowVisits: 0 })
        fireEvent.click(button)
        expect(button.getAttribute('aria-expanded')).toBe(String(expanded))
        expect(operations.copiedKeys).toBeGreaterThanOrEqual(history)
        expect(operations.copiedKeys).toBeLessThanOrEqual(2 * (history + 1))
        expect(operations.membershipChecks).toBeGreaterThanOrEqual(groups)
        expect(operations.membershipChecks).toBeLessThanOrEqual(2 * groups)
        expect(operations.rowVisits).toBeGreaterThanOrEqual(2 * groups)
        expect(operations.rowVisits).toBeLessThanOrEqual(4 * groups)
        clicks.push({ ...operations })
      }
    } finally {
      copied.mockRestore()
      membership.mockRestore()
    }
    view.rerender(table(page(history, groups).map((row) => ({ ...row }))))
    const milliseconds = Array.from({ length: 20 }, () => {
      const start = performance.now()
      fireEvent.click(button)
      return performance.now() - start
    }).sort((a, b) => a - b)
    console.info(
      'Linear section-click benchmark',
      JSON.stringify({ history, groups, clicks, milliseconds })
    )
    view.unmount()
    return clicks.map(
      ({ copiedKeys, membershipChecks, rowVisits }) => copiedKeys + membershipChecks + rowVisits
    )
  })
  for (let click = 0; click < 2; click += 1) {
    expect(samples[1][click]).toBeLessThanOrEqual(12 * samples[0][click])
  }
})
