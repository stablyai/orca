// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { collectHeaderDragBlockRowElements } from './header-drag-preview-rows'

/** Build a scroll container of virtual rows. Each entry is the inner HTML of
 *  one `[data-worktree-virtual-row]` wrapper. Returns the container. */
function buildRows(inner: string[]): HTMLElement {
  const container = document.createElement('div')
  for (const html of inner) {
    const row = document.createElement('div')
    row.setAttribute('data-worktree-virtual-row', '')
    row.innerHTML = html
    container.appendChild(row)
  }
  return container
}

function headerEl(container: HTMLElement, selector: string): HTMLElement {
  return container.querySelector<HTMLElement>(selector)!
}

describe('collectHeaderDragBlockRowElements', () => {
  it('project block = header + its worktrees, stopping at the next header', () => {
    const container = buildRows([
      '<div data-repo-header-id="r1">P1</div>',
      '<div data-worktree-id="wt-1">wt</div>',
      '<div data-worktree-id="wt-2">wt</div>',
      '<div data-repo-header-id="r2">P2</div>',
      '<div data-worktree-id="wt-3">wt</div>'
    ])
    const rows = collectHeaderDragBlockRowElements({
      headerEl: headerEl(container, '[data-repo-header-id="r1"]'),
      mode: 'project'
    })
    expect(rows).toHaveLength(3) // P1 header + its 2 worktrees
    expect(rows[0]!.querySelector('[data-repo-header-id="r1"]')).not.toBeNull()
    expect(rows[2]!.querySelector('[data-worktree-id="wt-2"]')).not.toBeNull()
  })

  it('project block stops at a following group header too', () => {
    const container = buildRows([
      '<div data-repo-header-id="r1">P1</div>',
      '<div data-worktree-id="wt-1">wt</div>',
      '<div data-project-group-header-id="g2" data-project-group-parent="">G2</div>'
    ])
    const rows = collectHeaderDragBlockRowElements({
      headerEl: headerEl(container, '[data-repo-header-id="r1"]'),
      mode: 'project'
    })
    expect(rows).toHaveLength(2)
  })

  it('group block includes nested rows, stopping at the next same-level sibling group', () => {
    const container = buildRows([
      '<div data-project-group-header-id="gA" data-project-group-parent="">GA</div>',
      '<div data-repo-header-id="r1">P1</div>',
      '<div data-worktree-id="wt-1">wt</div>',
      '<div data-project-group-header-id="gNested" data-project-group-parent="gA">nested</div>',
      '<div data-worktree-id="wt-2">wt</div>',
      '<div data-project-group-header-id="gB" data-project-group-parent="">GB</div>'
    ])
    const rows = collectHeaderDragBlockRowElements({
      headerEl: headerEl(container, '[data-project-group-header-id="gA"]'),
      mode: 'group',
      parentAttr: ''
    })
    // GA header + its project + worktree + nested group + its worktree (5),
    // stopping at sibling GB.
    expect(rows).toHaveLength(5)
    expect(rows.at(-1)!.querySelector('[data-worktree-id="wt-2"]')).not.toBeNull()
  })

  it('returns [] when the header is not inside a virtual row', () => {
    const orphan = document.createElement('div')
    orphan.setAttribute('data-repo-header-id', 'r1')
    expect(collectHeaderDragBlockRowElements({ headerEl: orphan, mode: 'project' })).toEqual([])
  })
})
