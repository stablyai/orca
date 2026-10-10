// @vitest-environment happy-dom

/**
 * The filter count badge on the workspace options button must disappear while
 * "Hide filter badge" is on, without stripping the count from the accessible
 * name — screen-reader users keep the state, only the visual noise goes.
 */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  filterBadge: {
    current: { hasAnyFilter: true, activeFilterCount: 2, activeFilterLabel: '2 filters' }
  }
}))

type MockState = {
  hideWorkspaceFilterBadge: boolean
  setHideWorkspaceFilterBadge: (v: boolean) => void
}

let mockState: MockState

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: MockState) => unknown) => selector(mockState)
  useAppStore.getState = () => mockState
  return { useAppStore }
})

vi.mock('./workspace-options-menu-items', () => ({
  useWorkspaceOptionsFilterBadge: () => mocks.filterBadge.current,
  WorkspaceOptionsMenuItems: () => null
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

let container: HTMLDivElement
let root: Root

function optionsButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Workspace options (2 filters)"]'
  )
  if (!button) {
    throw new Error('Workspace options button not rendered')
  }
  return button
}

function badgeText(): string | null {
  return optionsButton().querySelector('span[aria-hidden="true"]')?.textContent ?? null
}

beforeEach(() => {
  mocks.filterBadge.current = {
    hasAnyFilter: true,
    activeFilterCount: 2,
    activeFilterLabel: '2 filters'
  }
  mockState = {
    hideWorkspaceFilterBadge: false,
    setHideWorkspaceFilterBadge: vi.fn()
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SidebarWorkspaceOptionsMenu filter badge', () => {
  it('renders the count badge by default', () => {
    act(() => {
      root.render(<SidebarWorkspaceOptionsMenu />)
    })

    expect(badgeText()).toBe('2')
  })

  it('drops the badge while Hide filter badge is on', () => {
    mockState.hideWorkspaceFilterBadge = true
    act(() => {
      root.render(<SidebarWorkspaceOptionsMenu />)
    })

    expect(badgeText()).toBeNull()
  })

  it('keeps the active-filter count in the accessible name either way', () => {
    act(() => {
      root.render(<SidebarWorkspaceOptionsMenu />)
    })
    expect(optionsButton().getAttribute('aria-label')).toBe('Workspace options (2 filters)')

    mockState.hideWorkspaceFilterBadge = true
    act(() => {
      root.unmount()
    })
    root = createRoot(container)
    act(() => {
      root.render(<SidebarWorkspaceOptionsMenu />)
    })
    expect(optionsButton().getAttribute('aria-label')).toBe('Workspace options (2 filters)')
  })
})
