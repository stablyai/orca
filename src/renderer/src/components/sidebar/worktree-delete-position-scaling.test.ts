// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { preserveDeleteSiblingPosition } from './worktree-context-menu-policy'

/** Deterministic non-monotonic tops, so DOM order and visual order genuinely disagree. */
const topFor = (index: number): number => (index * 73) % 200

function mountSidebar(rowCount: number): {
  sidebar: HTMLElement
  rows: HTMLElement[]
  measurementsByRow: Map<HTMLElement, number>
} {
  const sidebar = document.createElement('div')
  sidebar.setAttribute('data-worktree-sidebar', '')
  const measurementsByRow = new Map<HTMLElement, number>()
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const row = document.createElement('div')
    row.setAttribute('data-worktree-virtual-row', '')
    row.setAttribute('data-worktree-virtual-row-key', String(index))
    row.getBoundingClientRect = () => {
      measurementsByRow.set(row, (measurementsByRow.get(row) ?? 0) + 1)
      return { top: topFor(index) } as DOMRect
    }
    sidebar.append(row)
    return row
  })
  document.body.append(sidebar)
  return { sidebar, rows, measurementsByRow }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

it('measures each mounted sidebar row once when choosing a delete-position anchor', () => {
  const { rows, measurementsByRow } = mountSidebar(200)

  expect(typeof preserveDeleteSiblingPosition(rows[100]!)).toBe('function')

  // 200 rows measured once each, plus the target's own `desiredTop` read.
  const total = [...measurementsByRow.values()].reduce((sum, count) => sum + count, 0)
  expect(total).toBe(201)
})

// Why: hoisting the layout read out of the comparator must not change which row anchors the
// scroll position — that anchor is what keeps the list still under the user's cursor.
it('anchors on the same row the pre-hoist comparator sort would have chosen', () => {
  const { rows, measurementsByRow } = mountSidebar(200)
  const target = rows[100]!

  // Reference: the original sort, reading layout inside the comparator.
  const expectedOrder = [...rows].sort(
    (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
  )
  const targetIndex = expectedOrder.indexOf(target)
  const expectedAnchor = expectedOrder[targetIndex + 1] ?? expectedOrder[targetIndex - 1]!

  const restore = preserveDeleteSiblingPosition(target)
  // Unmount the deleted row so the restore falls through to the anchor it captured.
  target.remove()
  measurementsByRow.clear()
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0)

  restore()

  expect([...measurementsByRow.keys()]).toEqual([expectedAnchor])
})
