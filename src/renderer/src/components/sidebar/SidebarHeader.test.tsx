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

function createButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Create"]')
  if (!button) {
    throw new Error('Create button not rendered')
  }
  return button
}

async function openCreateMenu(): Promise<void> {
  await act(async () => {
    // Why not click(): the Radix trigger opens on pointerdown, which happy-dom does not synthesize.
    createButton().dispatchEvent(
      new window.PointerEvent('pointerdown', { bubbles: true, button: 0 })
    )
  })
}

function createMenuItem(label: string): HTMLElement {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) =>
    candidate.textContent?.includes(label)
  )
  if (!item) {
    throw new Error(`Create menu item not rendered: ${label}`)
  }
  return item
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
    await openCreateMenu()

    await act(async () => {
      createMenuItem('New workspace').click()
    })

    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('opens the composer the same way once projects exist', async () => {
    mockState.repos = [{ id: 'repo-a' }]
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    await openCreateMenu()
    await act(async () => {
      createMenuItem('New workspace').click()
    })

    expect(createButton().disabled).toBe(false)
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('offers Add project beside New workspace under the create button', async () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    await openCreateMenu()

    expect(createMenuItem('New workspace')).toBeTruthy()
    expect(createMenuItem('Add project')).toBeTruthy()

    await act(async () => {
      createMenuItem('Add project').click()
    })

    expect(mockState.openModal).toHaveBeenCalledWith('add-repo')
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).not.toHaveBeenCalled()
  })

  it('omits the shortcut hint when workspace creation is unassigned', async () => {
    mocks.shortcutLabel.current = null
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    await openCreateMenu()

    expect(document.querySelector('[data-slot="dropdown-menu-shortcut"]')).toBeNull()
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

  it('keeps the workspace filter alongside the active bell without Add Project', () => {
    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[aria-label="Turn off activity view"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Create"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Workspace options"]')).toBeNull()
    expect(container.querySelector('[aria-label="Add Project"]')).toBeNull()
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
    expect(container.querySelector('[aria-label="Add Project"]')).toBeNull()
    expect(container.querySelector('[aria-label="Create"]')).toBeTruthy()
  })

  it('keeps the same actions on one row at compact width', async () => {
    mockState.sidebarWidth = 220
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[aria-label="Add Project"]')).toBeNull()
    expect(container.querySelector('[aria-label="View activity"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Create"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Workspace options"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="More workspace actions"]')).toBeNull()

    await openCreateMenu()
    await act(async () => {
      createMenuItem('New workspace').click()
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

  // Why: the compact overflow existed only to carry Add Project, which now lives
  // under the create button, so both widths render one identical header.
  it('renders the same actions on both sides of the old wide-layout breakpoint', () => {
    for (const width of [234, 235]) {
      mockState.sidebarWidth = width
      act(() => {
        root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
      })
      expect(container.querySelector('[aria-label="More workspace actions"]')).toBeNull()
      expect(container.querySelector('[aria-label="Add Project"]')).toBeNull()
      expect(container.querySelector('[aria-label="Create"]')).toBeTruthy()
      expect(container.querySelector('[aria-label="Workspace options"]')).toBeTruthy()
    }
  })
})
