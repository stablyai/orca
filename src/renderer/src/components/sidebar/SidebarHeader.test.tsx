// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SidebarHeader from './SidebarHeader'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  openWorkspaceCreationComposerWithTourHandoff: vi.fn(),
  popoverContentProps: { current: null as Record<string, unknown> | null },
  toast: vi.fn()
}))

type MockState = {
  repos: { id: string }[]
  groupBy: string
  sidebarBody: 'workspaces' | 'agents'
  sidebarWidth: number
  setSidebarBody: (body: 'workspaces' | 'agents') => void
  openModal: (modal: string, data?: unknown) => void
  updateSettings: (patch: Record<string, unknown>) => void
  activeContextualTourId: string | null
  settings?: {
    showAgentsSidebar?: boolean
    experimentalAgentDashboardPopout?: boolean
    agentsSidebarIntroShown?: boolean
    agentsSidebarMigratedFromExperimental?: boolean
  }
}

let mockState: MockState

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: MockState) => unknown) => selector(mockState)
  useAppStore.getState = () => mockState
  return { useAppStore }
})

vi.mock('@/components/dashboard/useAgentBucketCounts', () => ({
  useAgentBucketCounts: () => ({ attention: 0, working: 0, done: 0, idle: 0 })
}))

vi.mock('./SidebarWorkspaceOptionsMenu', () => ({ default: () => null }))

vi.mock('./workspace-options-menu-items', () => ({
  useWorkspaceOptionsFilterBadge: () => ({
    hasAnyFilter: false,
    activeFilterCount: 0,
    activeFilterLabel: '0 filters'
  }),
  WorkspaceOptionsMenuItems: () => null
}))

vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => '⌘N' }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('../contextual-tours/workspace-creation-tour-handoff', () => ({
  openWorkspaceCreationComposerWithTourHandoff: mocks.openWorkspaceCreationComposerWithTourHandoff
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))

// Deterministic popover: expose the open flag instead of relying on radix portals.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    <div data-intro-open={open ? '' : undefined}>{children}</div>
  ),
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverArrow: () => <div data-testid="popover-arrow" />,
  PopoverContent: ({ children, ...props }: { children: React.ReactNode }) => {
    mocks.popoverContentProps.current = props
    return <>{children}</>
  }
}))

let container: HTMLDivElement
let root: Root

function newWorkspaceButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="New workspace"]')
  if (!button) {
    throw new Error('New workspace button not rendered')
  }
  return button
}

function workspaceViewLabel(): string {
  const button = container.querySelector<HTMLButtonElement>(
    'button[data-sidebar-section-title="projects"]'
  )
  const label = button?.querySelector<HTMLElement>('span:not([aria-hidden])')?.textContent
  if (!label) {
    throw new Error('Workspace view label not rendered')
  }
  return label
}

beforeEach(() => {
  mocks.openWorkspaceCreationComposerWithTourHandoff.mockClear()
  mocks.toast.mockClear()
  mockState = {
    repos: [],
    groupBy: 'repo',
    sidebarBody: 'workspaces',
    sidebarWidth: 280,
    setSidebarBody: vi.fn(),
    openModal: vi.fn(),
    updateSettings: vi.fn(),
    activeContextualTourId: null,
    // Hydrated settings: the Agents tab is hidden until settings load.
    settings: { showAgentsSidebar: true }
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SidebarHeader', () => {
  it('keeps New workspace clickable with zero projects, since the composer adds the first one', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const button = newWorkspaceButton()
    expect(button.disabled).toBe(false)

    act(() => {
      button.click()
    })

    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('opens the composer the same way once projects exist', () => {
    mockState.repos = [{ id: 'repo-a' }]
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    act(() => {
      newWorkspaceButton().click()
    })

    expect(newWorkspaceButton().disabled).toBe(false)
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('switches sidebar body to agents when clicking the agents tab in workspaces mode', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const agentTab = container.querySelector<HTMLButtonElement>(
      'button[data-sidebar-section-title="agents"]'
    )
    expect(agentTab).toBeTruthy()

    act(() => {
      agentTab?.click()
    })

    expect(mockState.setSidebarBody).toHaveBeenCalledWith('agents')
  })

  it('switches sidebar body to workspaces when clicking the projects tab in agents mode', () => {
    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const projectsTab = container.querySelector<HTMLButtonElement>(
      'button[data-sidebar-section-title="projects"]'
    )
    expect(projectsTab).toBeTruthy()

    act(() => {
      projectsTab?.click()
    })

    expect(mockState.setSidebarBody).toHaveBeenCalledWith('workspaces')
  })

  it('always labels the workspace view as Spaces', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(workspaceViewLabel()).toBe('Spaces')

    mockState.groupBy = 'workspace-status'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    expect(workspaceViewLabel()).toBe('Spaces')

    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    expect(workspaceViewLabel()).toBe('Spaces')

    mockState.sidebarBody = 'workspaces'
    mockState.groupBy = 'none'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    expect(workspaceViewLabel()).toBe('Spaces')

    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    expect(workspaceViewLabel()).toBe('Spaces')
  })

  it('omits the Agents tab and returns to workspaces when it is disabled', () => {
    mockState.sidebarBody = 'agents'
    mockState.settings = { showAgentsSidebar: false }

    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('button[data-sidebar-section-title="agents"]')).toBeNull()
    expect(mockState.setSidebarBody).toHaveBeenCalledWith('workspaces')
  })

  it('does not render workspace action buttons in agents mode', () => {
    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[aria-label="New workspace"]')).toBeNull()
    expect(container.querySelector('[aria-label="Add Project"]')).toBeNull()
  })

  it('keeps the view toggle and actions on one row at the default sidebar width', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const headerRow = container.querySelector('[role="radiogroup"]')?.parentElement
    const headerClasses = new Set(headerRow?.className.split(/\s+/) ?? [])
    expect(headerClasses.has('flex-wrap')).toBe(false)
    expect(headerClasses.has('h-9')).toBe(true)
    expect(container.querySelector('[aria-label="Add Project"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="New workspace"]')).toBeTruthy()
  })

  it('keeps New workspace and a more menu on one row at compact width', () => {
    mockState.sidebarWidth = 220
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[aria-label="Add Project"]')).toBeNull()
    expect(container.querySelector('[aria-label="New workspace"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="More workspace actions"]')).toBeTruthy()

    act(() => {
      newWorkspaceButton().click()
    })
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('keeps the intro closed and unstamped before settings hydrate', () => {
    mockState.settings = undefined
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[data-intro-open]')).toBeNull()

    const projectsTab = container.querySelector<HTMLButtonElement>(
      'button[data-sidebar-section-title="projects"]'
    )
    act(() => {
      projectsTab?.click()
    })
    expect(mockState.updateSettings).not.toHaveBeenCalled()
  })

  it('does not reset a persisted agents body before settings hydrate', () => {
    mockState.settings = undefined
    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(mockState.setSidebarBody).not.toHaveBeenCalled()
  })

  it('opens the intro once hydrated and stamps it only while it is on screen', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[data-intro-open]')).toBeTruthy()

    const agentTab = container.querySelector<HTMLButtonElement>(
      'button[data-sidebar-section-title="agents"]'
    )
    act(() => {
      agentTab?.click()
    })
    expect(mockState.updateSettings).toHaveBeenCalledWith({ agentsSidebarIntroShown: true })
  })

  it('hides the Agents tab when a new user chooses Hide Agents', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const deferButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Hide Agents'
    )
    expect(deferButton).toBeTruthy()
    act(() => {
      deferButton?.click()
    })

    expect(mockState.updateSettings).toHaveBeenCalledWith({
      agentsSidebarIntroShown: true,
      showAgentsSidebar: false
    })
    expect(mocks.toast).toHaveBeenCalledWith(
      'Agents tab hidden. Re-enable it in Settings → Experimental.'
    )
  })

  it('shows only Open Agents for migrated users', () => {
    mockState.settings = {
      showAgentsSidebar: true,
      agentsSidebarMigratedFromExperimental: true
    }
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const introButtons = Array.from(container.querySelectorAll('button')).filter((button) =>
      ['Open Agents', 'Hide Agents'].includes(button.textContent?.trim() ?? '')
    )
    expect(introButtons).toHaveLength(1)
    expect(introButtons[0]?.textContent?.trim()).toBe('Open Agents')
  })

  it('prevents auto-focus and outside focus transfers from dismissing the intro popover', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const props = mocks.popoverContentProps.current as {
      onOpenAutoFocus?: (event: Event) => void
      onFocusOutside?: (event: Event) => void
    } | null

    expect(props).toBeTruthy()

    const openEvent = new Event('openAutoFocus')
    const openPreventDefault = vi.spyOn(openEvent, 'preventDefault')
    props?.onOpenAutoFocus?.(openEvent)
    expect(openPreventDefault).toHaveBeenCalled()

    const focusOutsideEvent = new Event('focusOutside')
    const focusOutsidePreventDefault = vi.spyOn(focusOutsideEvent, 'preventDefault')
    props?.onFocusOutside?.(focusOutsideEvent)
    expect(focusOutsidePreventDefault).toHaveBeenCalled()
  })

  it('never re-stamps the intro after it was acknowledged', () => {
    mockState.settings = { showAgentsSidebar: true, agentsSidebarIntroShown: true }
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[data-intro-open]')).toBeNull()

    const agentTab = container.querySelector<HTMLButtonElement>(
      'button[data-sidebar-section-title="agents"]'
    )
    act(() => {
      agentTab?.click()
    })
    expect(mockState.updateSettings).not.toHaveBeenCalled()
  })

  it('does not expose the deprecated full Agents view in agents mode', () => {
    mockState.settings = { showAgentsSidebar: true, agentsSidebarIntroShown: true }
    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[aria-label="Open full Agents view"]')).toBeNull()
  })

  it('switches to compact actions only below the wide-layout breakpoint', () => {
    mockState.sidebarWidth = 234
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    expect(container.querySelector('[aria-label="More workspace actions"]')).toBeTruthy()

    mockState.sidebarWidth = 235
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    expect(container.querySelector('[aria-label="More workspace actions"]')).toBeNull()
    expect(container.querySelector('[aria-label="Add Project"]')).toBeTruthy()
  })
})
