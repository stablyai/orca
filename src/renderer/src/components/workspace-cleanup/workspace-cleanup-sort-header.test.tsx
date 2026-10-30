// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceCleanupSortState } from '../../../../shared/workspace-cleanup-filter-model'
import { WorkspaceCleanupSortHeader } from './workspace-cleanup-sort-header'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
    <button type="button" data-sort-option onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(sort: WorkspaceCleanupSortState, handlers: Record<string, unknown> = {}): void {
  act(() =>
    root?.render(
      <WorkspaceCleanupSortHeader
        sort={sort}
        selectableCount={3}
        selectedCount={0}
        onToggleSortField={vi.fn()}
        onToggleSelectAll={vi.fn()}
        {...handlers}
      />
    )
  )
}

describe('WorkspaceCleanupSortHeader', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('exposes a partial selection as mixed', () => {
    render({ field: 'name', direction: 'asc' }, { selectableCount: 3, selectedCount: 1 })

    expect(
      container?.querySelector<HTMLButtonElement>('[role="checkbox"]')?.getAttribute('aria-checked')
    ).toBe('mixed')
  })
})
