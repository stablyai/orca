import { describe, expect, it, vi } from 'vitest'
import type { GroupHeaderRow } from '../grouping/row-types'
import { activateSectionHeader, getSectionHeaderExpansion } from './section-header-state'

function header(overrides: Partial<GroupHeaderRow> = {}): GroupHeaderRow {
  return { type: 'header', key: 'repo:a', label: 'a', count: 2, tone: '', ...overrides }
}

function activate(row: GroupHeaderRow, isCollapsed = false) {
  const toggle = vi.fn()
  const activateCompactProject = vi.fn()
  activateSectionHeader({ row, isCollapsed, toggle, activateCompactProject })
  return { toggle, activateCompactProject }
}

describe('activateSectionHeader', () => {
  it('toggles a regular header', () => {
    expect(activate(header()).toggle).toHaveBeenCalledTimes(1)
  })

  it('folds the open compact project from the keyboard or a click', () => {
    const row = header({ compactProjectActive: true, projectWorktreeIds: ['w1', 'w2'] })
    const { toggle, activateCompactProject } = activate(row)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(activateCompactProject).not.toHaveBeenCalled()
  })

  it('opens a folded compact project by activating it, clearing a stale chevron fold', () => {
    const row = header({ compactProjectActive: false, projectWorktreeIds: ['w1', 'w2'] })
    expect(activate(row).activateCompactProject).toHaveBeenCalledWith(['w1', 'w2'])
    const stale = activate(row, true)
    expect(stale.toggle).toHaveBeenCalledTimes(1)
    expect(stale.activateCompactProject).toHaveBeenCalledTimes(1)
  })

  it('keeps the default toggle for an empty compact project', () => {
    const { toggle, activateCompactProject } = activate(
      header({ count: 0, compactProjectActive: false, projectWorktreeIds: [] })
    )
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(activateCompactProject).not.toHaveBeenCalled()
  })
})

describe('getSectionHeaderExpansion', () => {
  it('shows the chevron only on the open compact project', () => {
    const open = header({ compactProjectActive: true, projectWorktreeIds: ['w1', 'w2'] })
    const folded = header({ compactProjectActive: false, projectWorktreeIds: ['w1', 'w2'] })
    expect(getSectionHeaderExpansion({ row: open, isCollapsed: false, collapsible: true })).toEqual(
      { showCollapseAffordance: true, ariaExpanded: true }
    )
    expect(
      getSectionHeaderExpansion({ row: folded, isCollapsed: false, collapsible: true })
    ).toEqual({ showCollapseAffordance: false, ariaExpanded: false })
    expect(getSectionHeaderExpansion({ row: open, isCollapsed: true, collapsible: true })).toEqual({
      showCollapseAffordance: true,
      ariaExpanded: false
    })
  })

  it('keeps regular headers unchanged', () => {
    expect(
      getSectionHeaderExpansion({ row: header(), isCollapsed: true, collapsible: true })
    ).toEqual({ showCollapseAffordance: true, ariaExpanded: false })
  })
})
