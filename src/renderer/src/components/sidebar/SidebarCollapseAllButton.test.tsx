// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarCollapseAllButton } from './SidebarCollapseAllButton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

afterEach(cleanup)

describe('SidebarCollapseAllButton', () => {
  it('collapses expanded sections', () => {
    const onCollapseAll = vi.fn()
    const { container } = render(
      <SidebarCollapseAllButton
        headerKeys={['pinned', 'repo:orca']}
        collapsedGroups={new Set(['pinned'])}
        onCollapseAll={onCollapseAll}
        onExpandAll={vi.fn()}
        compact={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))

    expect(onCollapseAll).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.lucide-chevrons-down-up')).toBeTruthy()
    expect(container.querySelector('.lucide-chevrons-up-down')).toBeNull()
  })

  it('expands fully collapsed sections', () => {
    const onExpandAll = vi.fn()
    const { container } = render(
      <SidebarCollapseAllButton
        headerKeys={['pinned', 'repo:orca']}
        collapsedGroups={new Set(['pinned', 'repo:orca'])}
        onCollapseAll={vi.fn()}
        onExpandAll={onExpandAll}
        compact={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))

    expect(onExpandAll).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.lucide-chevrons-up-down')).toBeTruthy()
    expect(container.querySelector('.lucide-chevrons-down-up')).toBeNull()
  })

  it('renders nothing without section headers', () => {
    const { container } = render(
      <SidebarCollapseAllButton
        headerKeys={[]}
        collapsedGroups={new Set()}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
        compact={false}
      />
    )

    expect(container.firstChild).toBeNull()
  })

  it('runs the compact action inside a dropdown menu', () => {
    const onCollapseAll = vi.fn()
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <SidebarCollapseAllButton
            headerKeys={['pinned', 'repo:orca']}
            collapsedGroups={new Set()}
            onCollapseAll={onCollapseAll}
            onExpandAll={vi.fn()}
            compact
          />
        </DropdownMenuContent>
      </DropdownMenu>
    )

    fireEvent.click(screen.getByRole('menuitem', { name: 'Collapse all' }))

    expect(onCollapseAll).toHaveBeenCalledTimes(1)
  })
})
