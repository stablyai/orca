// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createAppCommandHandlers, type AppShortcutState } from '@/app-shell/app-command-handlers'
import Sidebar from './index'
import { TOGGLE_WORKSPACE_BOARD_EVENT } from './useWorkspaceBoardPanel'

vi.mock('./SidebarNav', () => ({ default: () => null }))
vi.mock('./SetupScriptPromptCard', () => ({ default: () => null }))
vi.mock('./SidebarToolbar', () => ({ default: () => null }))
vi.mock('./WorktreeList', () => ({ default: () => null }))
vi.mock('./LocalGitToolchainScanBanner', () => ({ LocalGitToolchainScanBanner: () => null }))
vi.mock('./useSidebarProjectDrop', () => ({
  useSidebarProjectDrop: () => ({
    nativeDropTarget: undefined,
    dropHandlers: {},
    affordance: { visible: false }
  })
}))
vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({ useContextualTour: vi.fn() }))

const initialState = useAppStore.getInitialState()

function boardCommand(
  activeView: AppShortcutState['activeView'] = 'terminal'
): boolean | undefined {
  const store = useAppStore.getState()
  return createAppCommandHandlers({
    activeView,
    activeWorktreeId: null,
    actions: store,
    creationLayoutActive: false,
    floatingTerminalEnabled: false,
    floatingTerminalOpen: false,
    floatingVisibleTabCount: 0,
    keybindings: {},
    openFloatingWorkspaceMaximized: vi.fn(),
    pluginCommands: [],
    setFloatingTerminalOpen: vi.fn(),
    terminalShortcutPolicy: 'orca-first',
    workspaceChromeActive: true
  }).get('workspace.openBoard')?.()
}

function renderSidebar(): void {
  render(
    <Sidebar worktreeScrollOffsetRef={{ current: 0 }} worktreeScrollAnchorRef={{ current: null }} />
  )
}

beforeEach(() => {
  useAppStore.setState({ sidebarOpen: false, sidebarWidth: 320, recordFeatureInteraction: vi.fn() })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('workspace board sidebar visibility', () => {
  it('opens and toggles the board without revealing the hidden sidebar', () => {
    renderSidebar()

    act(() => expect(boardCommand()).toBe(true))

    expect(useAppStore.getState().sidebarOpen).toBe(false)
    expect(screen.getByRole('dialog').style.left).toBe('0px')

    act(() => expect(boardCommand()).toBe(true))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useAppStore.getState().sidebarOpen).toBe(false)
  })

  it('renders the board from its toggle event while the sidebar is hidden', () => {
    renderSidebar()

    act(() => window.dispatchEvent(new CustomEvent(TOGGLE_WORKSPACE_BOARD_EVENT)))

    expect(screen.getByRole('dialog').style.left).toBe('0px')
  })

  it('keeps the board open and updates its position when the sidebar is hidden or revealed', () => {
    useAppStore.setState({ sidebarOpen: true })
    renderSidebar()
    act(() => boardCommand())
    expect(screen.getByRole('dialog').style.left).toBe('var(--workspace-sidebar-live-width, 320px)')

    act(() => useAppStore.getState().setSidebarOpen(false))

    expect(screen.getByRole('dialog').style.left).toBe('0px')

    act(() => useAppStore.getState().setSidebarOpen(true))

    expect(screen.getByRole('dialog').style.left).toBe('var(--workspace-sidebar-live-width, 320px)')
  })

  it('dismisses the board with Escape while preserving the hidden sidebar', () => {
    renderSidebar()
    act(() => boardCommand())

    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useAppStore.getState().sidebarOpen).toBe(false)
  })

  it('dismisses the board after hiding the sidebar with its workspace options menu open', () => {
    useAppStore.setState({ sidebarOpen: true })
    renderSidebar()
    act(() => boardCommand())
    fireEvent.pointerDown(screen.getAllByRole('button', { name: 'Workspace options' })[0], {
      button: 0,
      ctrlKey: false
    })
    expect(screen.getByRole('menu')).toBeTruthy()

    act(() => useAppStore.getState().setSidebarOpen(false))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useAppStore.getState().sidebarOpen).toBe(false)
  })

  it('keeps the board filter menu active when its closed sidebar menu unmounts', () => {
    useAppStore.setState({ sidebarOpen: true })
    renderSidebar()
    act(() => boardCommand())
    fireEvent.pointerDown(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Filter workspaces'
      }),
      { button: 0, ctrlKey: false }
    )
    expect(screen.getByRole('menu')).toBeTruthy()

    act(() => useAppStore.getState().setSidebarOpen(false))
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.pointerDown(document, { clientX: 1, clientY: 0 })
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not open the board from settings', () => {
    renderSidebar()

    act(() => expect(boardCommand('settings')).toBe(false))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useAppStore.getState().sidebarOpen).toBe(false)
  })
})
