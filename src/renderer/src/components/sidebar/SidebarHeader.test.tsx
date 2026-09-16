// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SidebarHeader from './SidebarHeader'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => {
  const popoverContentProps: { current: Record<string, unknown> | null } = { current: null }
  const shortcutLabel: { current: string | null } = { current: '⌘N' }

  return {
    openWorkspaceCreationComposerWithTourHandoff: vi.fn(),
    popoverContentProps,
    shortcutLabel,
    toast: vi.fn()
  }
})

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

vi.mock('./SidebarWorkspaceOptionsMenu', () => ({
  default: () => <button aria-label="Workspace options" type="button" />
}))

vi.mock('./workspace-options-menu-items', () => ({
  useWorkspaceOptionsFilterBadge: () => ({
    hasAnyFilter: false,
    activeFilterCount: 0,
    activeFilterLabel: '0 filters'
  }),
  WorkspaceOptionsMenuItems: () => null
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => '⌘N',
  formatOptionalPrimaryShortcutLabel: () => mocks.shortcutLabel.current
}))

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

function headerButton(label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  if (!button) {
    throw new Error(`Header button not rendered: ${label}`)
  }
  return button
}

function createButton(): HTMLButtonElement {
  return headerButton('New workspace')
}

beforeEach(() => {
  mocks.openWorkspaceCreationComposerWithTourHandoff.mockClear()
  mocks.toast.mockClear()
  mocks.shortcutLabel.current = '⌘N'
  mockState = {
    repos: [],
    groupBy: 'repo',
    sidebarBody: 'workspaces',
    sidebarWidth: 280,
    setSidebarBody: vi.fn(),
    openModal: vi.fn(),
    updateSettings: vi.fn(),
    activeContextualTourId: null,
    settings: {}
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
  it('keeps New workspace clickable with zero projects, since the composer adds the first one', async () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(createButton().disabled).toBe(false)

    await act(async () => {
      createButton().click()
    })

    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('opens the composer the same way once projects exist', async () => {
    mockState.repos = [{ id: 'repo-a' }]
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    await act(async () => {
      createButton().click()
    })

    expect(createButton().disabled).toBe(false)
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('reaches Add project and New workspace in one click each, with no menu', async () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(headerButton('New workspace')).toBeTruthy()
    expect(headerButton('Add project')).toBeTruthy()
    expect(container.querySelector('[data-slot="dropdown-menu-trigger"]')).toBeNull()

    await act(async () => {
      headerButton('Add project').click()
    })

    expect(mockState.openModal).toHaveBeenCalledWith('add-repo')
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).not.toHaveBeenCalled()
  })

  it('keeps the create button rightmost so the frequent action stays where it was', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const labels = [...container.querySelectorAll<HTMLElement>('[aria-label]')]
      .map((node) => node.getAttribute('aria-label'))
      .filter((label): label is string => label === 'Add project' || label === 'New workspace')
    expect(labels).toEqual(['Add project', 'New workspace'])
  })

  it('advertises the workspace shortcut on the create tooltip, and omits it when unassigned', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    expect(container.textContent).toContain('⌘N')

    mocks.shortcutLabel.current = null
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    expect(container.textContent).not.toContain('⌘N')
  })

  it('opens agent activity from the bell button', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const activityButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="View activity"]'
    )
    expect(activityButton).toBeTruthy()

    act(() => {
      activityButton?.click()
    })

    expect(mockState.setSidebarBody).toHaveBeenCalledWith('agents')
  })

  it('shows the Agents introduction only for migrated users and never offers a hide action', () => {
    mockState.settings = { agentsSidebarMigratedFromExperimental: true }
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[data-intro-open]')).toBeTruthy()
    expect(container.textContent).toContain('Agents are easier to find')
    expect(container.textContent).not.toContain('Hide Agents')

    mockState.settings = {}
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    expect(container.querySelector('[data-intro-open]')).toBeNull()
  })

  it('turns off agent activity from the active bell button', () => {
    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const activityButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Turn off activity view"]'
    )
    expect(activityButton?.getAttribute('aria-pressed')).toBe('true')

    act(() => {
      activityButton?.click()
    })

    expect(mockState.setSidebarBody).toHaveBeenCalledWith('workspaces')
  })

  it('uses the legacy title based on workspace grouping', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[data-sidebar-section-title="projects"]')?.textContent).toBe(
      'Projects'
    )

    mockState.groupBy = 'workspace-status'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })
    expect(container.querySelector('[data-sidebar-section-title="workspaces"]')?.textContent).toBe(
      'Workspaces'
    )
  })

  it('drops both project actions in the agents view, which lists activity, not projects', () => {
    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[aria-label="Turn off activity view"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="New workspace"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Workspace options"]')).toBeNull()
    expect(container.querySelector('[aria-label="Add project"]')).toBeNull()
  })

  it('keeps the activity bell and actions on one row at the default sidebar width', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const headerRow = container.querySelector('.mt-2')
    const headerClasses = new Set(headerRow?.className.split(/\s+/) ?? [])
    expect(headerClasses.has('flex-wrap')).toBe(false)
    expect(headerClasses.has('h-8')).toBe(true)
    expect(container.querySelector('[aria-label="View activity"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Add project"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="New workspace"]')).toBeTruthy()
  })

  it('keeps the same actions on one row at compact width', async () => {
    mockState.sidebarWidth = 220
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[aria-label="Add project"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="View activity"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="New workspace"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Workspace options"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="More workspace actions"]')).toBeNull()

    await act(async () => {
      createButton().click()
    })
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('does not reset a persisted agents body before settings hydrate', () => {
    mockState.settings = undefined
    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(mockState.setSidebarBody).not.toHaveBeenCalled()
  })

  it('does not expose the deprecated full Agents view in agents mode', () => {
    mockState.settings = { agentsSidebarIntroShown: true }
    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[aria-label="Open full Agents view"]')).toBeNull()
  })

  // Why: the compact overflow existed only to carry Add Project, which now sits
  // beside the create button, so both widths render one identical header.
  it('renders the same actions on both sides of the old wide-layout breakpoint', () => {
    for (const width of [234, 235]) {
      mockState.sidebarWidth = width
      act(() => {
        root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
      })
      expect(container.querySelector('[aria-label="More workspace actions"]')).toBeNull()
      expect(container.querySelector('[aria-label="Add project"]')).toBeTruthy()
      expect(container.querySelector('[aria-label="New workspace"]')).toBeTruthy()
      expect(container.querySelector('[aria-label="Workspace options"]')).toBeTruthy()
    }
  })
})
