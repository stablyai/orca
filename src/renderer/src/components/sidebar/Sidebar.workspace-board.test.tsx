// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createAppCommandHandlers, type AppShortcutState } from '@/app-shell/app-command-handlers'
import Sidebar from './index'

vi.mock('./SidebarNav', () => ({ default: () => null }))
vi.mock('./SetupScriptPromptCard', () => ({ default: () => null }))
vi.mock('./SidebarToolbar', () => ({ default: () => null }))
vi.mock('./WorktreeList', () => ({ default: () => null }))
vi.mock('./LocalGitToolchainScanBanner', () => ({ LocalGitToolchainScanBanner: () => null }))
vi.mock('./useSidebarProjectDrop', () => ({
  useSidebarProjectDrop: () => ({
    dropOwnerRef: vi.fn(),
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

it('opens and toggles the board without revealing the hidden sidebar', () => {
  renderSidebar()
  act(() => expect(boardCommand('settings')).toBe(false))
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() => expect(boardCommand()).toBe(true))
  expect(useAppStore.getState().sidebarOpen).toBe(false)
  expect(screen.getByRole('dialog').style.left).toBe('0px')
  act(() => expect(boardCommand()).toBe(true))
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() => boardCommand())
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(useAppStore.getState().sidebarOpen).toBe(false)
})

it.each(['sidebar', 'board'] as const)(
  'clears only the open %s menu when hiding the sidebar',
  (menu) => {
    useAppStore.setState({ sidebarOpen: true })
    renderSidebar()
    act(() => boardCommand())
    const trigger =
      menu === 'sidebar'
        ? screen.getAllByRole('button', { name: 'Workspace options' })[0]
        : within(screen.getByRole('dialog')).getByRole('button', { name: 'Filter workspaces' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    expect(screen.getByRole('menu')).toBeTruthy()
    act(() => useAppStore.getState().setSidebarOpen(false))
    expect(screen.getByRole('dialog')).toBeTruthy()
    if (menu === 'sidebar') {
      expect(screen.queryByRole('menu')).toBeNull()
    } else {
      expect(screen.getByRole('menu')).toBeTruthy()
      fireEvent.pointerDown(document, { clientX: 1, clientY: 0 })
      expect(screen.getByRole('dialog')).toBeTruthy()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      expect(screen.getByRole('dialog')).toBeTruthy()
    }
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useAppStore.getState().sidebarOpen).toBe(false)
  }
)
