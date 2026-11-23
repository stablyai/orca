// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_CLEANUP_SORT } from '../../../../../shared/workspace-cleanup/workspace-cleanup-filter-model'
import { WorkspaceCleanupSortHeader } from './workspace-cleanup-sort-header'

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

function mount(counts: { bulk: number; selectedBulk: number; selectedDisplayed: number }) {
  const onToggleSelectAll = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root!.render(
      <WorkspaceCleanupSortHeader
        sort={DEFAULT_WORKSPACE_CLEANUP_SORT}
        selectableCount={counts.bulk}
        selectedBulkCount={counts.selectedBulk}
        selectedSelectableCount={counts.selectedDisplayed}
        selectedCount={counts.selectedDisplayed}
        deleteDisabled={false}
        onToggleSortField={() => {}}
        onToggleSelectAll={onToggleSelectAll}
        onDeleteSelected={() => {}}
      />
    )
  )
  const box = container.querySelector<HTMLElement>('[role="checkbox"]')
  if (box === null) {
    throw new Error('select-all checkbox did not render')
  }
  return { box, onToggleSelectAll }
}

describe('WorkspaceCleanupSortHeader select-all control', () => {
  it('names the control by what it does', () => {
    expect(
      mount({ bulk: 3, selectedBulk: 0, selectedDisplayed: 0 }).box.getAttribute('aria-label')
    ).toMatch(/Select all 3/)
    act(() => root?.unmount())
    expect(
      mount({ bulk: 3, selectedBulk: 1, selectedDisplayed: 1 }).box.getAttribute('aria-label')
    ).toBe('Clear selection')
    act(() => root?.unmount())
    expect(
      mount({ bulk: 0, selectedBulk: 0, selectedDisplayed: 1 }).box.getAttribute('aria-label')
    ).toBe('Clear selection')
    act(() => root?.unmount())
    expect(
      mount({ bulk: 0, selectedBulk: 0, selectedDisplayed: 0 }).box.getAttribute('aria-label')
    ).not.toMatch(/Select all 0/)
  })

  it('selects all from empty', () => {
    const { box, onToggleSelectAll } = mount({ bulk: 3, selectedBulk: 0, selectedDisplayed: 0 })
    expect(box.getAttribute('aria-checked')).toBe('false')
    act(() => box.click())
    expect(onToggleSelectAll).toHaveBeenCalledWith(true)
  })

  it('clears from mixed instead of filling', () => {
    const { box, onToggleSelectAll } = mount({ bulk: 3, selectedBulk: 1, selectedDisplayed: 1 })
    expect(box.getAttribute('aria-checked')).toBe('mixed')
    act(() => box.click())
    expect(onToggleSelectAll).toHaveBeenCalledWith(false)
  })

  it('clears from fully checked', () => {
    const { box, onToggleSelectAll } = mount({ bulk: 3, selectedBulk: 3, selectedDisplayed: 3 })
    expect(box.getAttribute('aria-checked')).toBe('true')
    act(() => box.click())
    expect(onToggleSelectAll).toHaveBeenCalledWith(false)
  })

  it('shows mixed and stays enabled when only an ignored row is ticked', () => {
    const { box, onToggleSelectAll } = mount({ bulk: 0, selectedBulk: 0, selectedDisplayed: 1 })
    expect(box.getAttribute('aria-checked')).toBe('mixed')
    expect(box.hasAttribute('disabled')).toBe(false)
    act(() => box.click())
    expect(onToggleSelectAll).toHaveBeenCalledWith(false)
  })
})
