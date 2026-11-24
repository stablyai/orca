// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceCleanupGroupCards } from './workspace-cleanup-group-cards'
import { WorkspaceCleanupSelectAllBar } from './workspace-cleanup-select-all-bar'

afterEach(cleanup)

const SUMMARIES = {
  'nothing-local': { count: 4, selectedCount: 0 },
  'local-files': { count: 2, selectedCount: 1 },
  'cannot-delete': { count: 1, selectedCount: 0 }
} as const

describe('WorkspaceCleanupGroupCards', () => {
  it('exposes three tabs with the open one selected', () => {
    render(
      <WorkspaceCleanupGroupCards active="local-files" summaries={SUMMARIES} onChange={vi.fn()} />
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
  })

  it('moves between cards with the arrow keys', () => {
    const onChange = vi.fn()
    render(
      <WorkspaceCleanupGroupCards
        active="nothing-local"
        summaries={SUMMARIES}
        onChange={onChange}
      />
    )
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('local-files')
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('cannot-delete')
  })
})

describe('WorkspaceCleanupSelectAllBar', () => {
  const state = (selectedBulkCount: number) => (
    <WorkspaceCleanupSelectAllBar
      selectableCount={4}
      selectedBulkCount={selectedBulkCount}
      selectedDisplayedCount={selectedBulkCount}
      onToggle={vi.fn()}
    />
  )

  it.each([
    [0, 'false'],
    [2, 'mixed'],
    [4, 'true']
  ])('with %i of 4 ticked reports aria-checked=%s', (selected, expected) => {
    render(state(selected))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe(expected)
  })

  it('selects all from empty and clears from mixed', () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <WorkspaceCleanupSelectAllBar
        selectableCount={4}
        selectedBulkCount={0}
        selectedDisplayedCount={0}
        onToggle={onToggle}
      />
    )
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onToggle).toHaveBeenLastCalledWith(true)
    rerender(
      <WorkspaceCleanupSelectAllBar
        selectableCount={4}
        selectedBulkCount={2}
        selectedDisplayedCount={2}
        onToggle={onToggle}
      />
    )
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onToggle).toHaveBeenLastCalledWith(false)
  })

  it('stays enabled and mixed when only a row select-all skips is ticked', () => {
    const onToggle = vi.fn()
    render(
      <WorkspaceCleanupSelectAllBar
        selectableCount={0}
        selectedBulkCount={0}
        selectedDisplayedCount={1}
        onToggle={onToggle}
      />
    )
    const box = screen.getByRole('checkbox')
    expect(box.getAttribute('aria-checked')).toBe('mixed')
    expect(box.hasAttribute('disabled')).toBe(false)
    fireEvent.click(box)
    expect(onToggle).toHaveBeenCalledWith(false)
  })
})
