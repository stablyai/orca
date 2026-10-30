// @vitest-environment happy-dom

import type { ComponentProps, ReactNode } from 'react'
import { act, cleanup, render, waitFor, type RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import SidebarToolbar from '@/components/sidebar/SidebarToolbar'
import UsageDashboardSidebarHost from './UsageDashboardSidebarHost'

vi.mock('./UsageDashboardDrawer', () => ({
  default: () => <div data-testid="usage-dashboard-drawer" />
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu">{children}</div>
  ),
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
  ContextMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  )
}))

vi.mock('@/components/sidebar/SidebarSettingsHelpMenu', () => ({
  SidebarSettingsHelpMenu: () => <button type="button">Settings</button>
}))

vi.mock('@/components/sidebar/ScrollToCurrentWorkspaceToolbarButton', () => ({
  ScrollToCurrentWorkspaceToolbarButton: () => <button type="button">Current workspace</button>
}))

const initialState = useAppStore.getInitialState()

function renderHost(
  props: Partial<ComponentProps<typeof UsageDashboardSidebarHost>> = {}
): RenderResult {
  return render(
    <UsageDashboardSidebarHost
      sidebarOpen
      workspaceBoardOpen={false}
      closeWorkspaceBoard={vi.fn()}
      statusBarVisible
      {...props}
    />
  )
}

function renderToolbar(): RenderResult {
  return render(<SidebarToolbar workspaceBoardOpen={false} onWorkspaceBoardToggle={vi.fn()} />)
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('UsageDashboardSidebarHost', () => {
  it('renders the drawer only while it is open and the sidebar is open', () => {
    useAppStore.setState({ usageDrawerOpen: true })
    const open = renderHost()
    expect(open.queryByTestId('usage-dashboard-drawer')).not.toBeNull()
    cleanup()

    useAppStore.setState({ usageDrawerOpen: false })
    const closed = renderHost()
    expect(closed.queryByTestId('usage-dashboard-drawer')).toBeNull()
  })

  it('does not render the drawer when the sidebar is closed', () => {
    useAppStore.setState({ usageDrawerOpen: true })
    const view = renderHost({ sidebarOpen: false })

    expect(view.queryByTestId('usage-dashboard-drawer')).toBeNull()
  })

  it('clears an open usage drawer when the sidebar closes', async () => {
    useAppStore.setState({ usageDrawerOpen: true })
    const view = renderHost()

    view.rerender(
      <UsageDashboardSidebarHost
        sidebarOpen={false}
        workspaceBoardOpen={false}
        closeWorkspaceBoard={vi.fn()}
        statusBarVisible
      />
    )

    await waitFor(() => expect(useAppStore.getState().usageDrawerOpen).toBe(false))
  })

  it('closes the usage drawer when the workspace board opens', async () => {
    useAppStore.setState({ usageDrawerOpen: true })
    renderHost({ workspaceBoardOpen: true })

    await waitFor(() => expect(useAppStore.getState().usageDrawerOpen).toBe(false))
  })

  it('closes the workspace board when the usage drawer opens', async () => {
    const closeWorkspaceBoard = vi.fn()
    const view = renderHost({ closeWorkspaceBoard })

    act(() => useAppStore.setState({ usageDrawerOpen: true }))
    view.rerender(
      <UsageDashboardSidebarHost
        sidebarOpen
        workspaceBoardOpen={false}
        closeWorkspaceBoard={closeWorkspaceBoard}
        statusBarVisible
      />
    )

    await waitFor(() => expect(closeWorkspaceBoard).toHaveBeenCalledOnce())
  })
})

describe('SidebarToolbar token usage button', () => {
  it('shows the token usage icon by default', () => {
    useAppStore.setState({ settings: { ...getDefaultSettings('/tmp') } })
    const view = renderToolbar()

    expect(view.queryByLabelText('Token usage')).not.toBeNull()
  })

  it('hides the token usage icon when showUsageButton is off', () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), showUsageButton: false }
    })
    const view = renderToolbar()

    expect(view.queryByLabelText('Token usage')).toBeNull()
  })

  it('toggles the usage drawer from the icon', () => {
    const setUsageDrawerOpen = vi.fn()
    useAppStore.setState({ usageDrawerOpen: false, setUsageDrawerOpen })
    const view = renderToolbar()

    act(() => view.getByLabelText('Token usage').click())

    expect(setUsageDrawerOpen).toHaveBeenCalledWith(true)
  })

  it('hides the token usage button from its context menu', () => {
    const updateSettings = vi.fn()
    useAppStore.setState({ settings: { ...getDefaultSettings('/tmp') }, updateSettings })
    const view = renderToolbar()

    act(() => view.getByText('Hide from sidebar').click())

    expect(updateSettings).toHaveBeenCalledWith({ showUsageButton: false })
  })
})
