// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { TOGGLE_WORKSPACE_BOARD_EVENT } from '@/components/sidebar/workspace-board/surface/useWorkspaceBoardPanel'
import { APP_RAIL_DESTINATION_IDS } from '@/components/app-rail/app-rail-layout'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { createAppCommandHandlers, type AppShortcutState } from './app-command-handlers'

// Invariant: with the rail on, a rail page hides the workspace list, so the list commands must first return to
// Workspaces with the list showing, writing nothing else, and only then act. A board-open event that fires while the
// view is still the page is lost to the collapsed list.

const OPEN_PAGE: Record<(typeof APP_RAIL_DESTINATION_IDS)[number], (s: AppState) => void> = {
  tasks: (s) => s.openTaskPage(),
  automations: (s) => s.openAutomationsPage(),
  artifacts: (s) => s.openArtifactsPage(),
  skills: (s) => s.openSkillsPage(),
  mobile: (s) => s.openMobilePage(),
  plugins: (s) => s.openPluginsPage()
}

const initial = useAppStore.getState()

function handlers(): Map<string, () => boolean> {
  const s = useAppStore.getState()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the two list commands under test read only activeView/workspaceChromeActive and call actions.toggleSidebar, which is the store's own; the rest of the shortcut actions are never reached.
  const state = {
    activeView: s.activeView,
    activeWorktreeId: s.activeWorktreeId,
    actions: { toggleSidebar: () => useAppStore.getState().toggleSidebar() },
    creationLayoutActive: false,
    floatingTerminalEnabled: false,
    floatingTerminalOpen: false,
    floatingVisibleTabCount: 0,
    keybindings: s.keybindings,
    openFloatingWorkspaceMaximized: () => {},
    pluginCommands: [],
    setFloatingTerminalOpen: () => {},
    terminalShortcutPolicy: undefined,
    workspaceChromeActive: false
  } as unknown as AppShortcutState
  return createAppCommandHandlers(state, undefined, 'app', true)
}

function setUp(railOn: boolean, sidebarOpen: boolean): void {
  useAppStore.setState({
    settings: {
      ...(initial.settings ?? getDefaultSettings('/fixture-home')),
      experimentalAppRail: railOn
    },
    activeView: 'terminal',
    sidebarOpen,
    sidebarWidth: 312,
    sidebarBody: 'workspaces'
  })
}

beforeEach(() => {
  useAppStore.setState(initial, true)
})
afterEach(() => {
  useAppStore.setState(initial, true)
})

it('on a rail page the list commands return to Workspaces with the list showing before acting', () => {
  for (const id of APP_RAIL_DESTINATION_IDS) {
    for (const savedOpen of [true, false]) {
      setUp(true, savedOpen)
      OPEN_PAGE[id](useAppStore.getState())
      expect(useAppStore.getState().activeView).toBe(id)
      expect(handlers().get('sidebar.left.toggle')?.()).toBe(true)
      expect(useAppStore.getState()).toMatchObject({
        activeView: 'terminal',
        sidebarBody: 'workspaces',
        sidebarOpen: true,
        sidebarWidth: 312
      })

      setUp(true, savedOpen)
      OPEN_PAGE[id](useAppStore.getState())
      const seen: { activeView: string; sidebarOpen: boolean }[] = []
      const listener = (): void => {
        const { activeView, sidebarOpen } = useAppStore.getState()
        seen.push({ activeView, sidebarOpen })
      }
      window.addEventListener(TOGGLE_WORKSPACE_BOARD_EVENT, listener)
      try {
        expect(handlers().get('workspace.openBoard')?.()).toBe(true)
      } finally {
        window.removeEventListener(TOGGLE_WORKSPACE_BOARD_EVENT, listener)
      }
      expect(seen).toEqual([{ activeView: 'terminal', sidebarOpen: true }])
      expect(useAppStore.getState().sidebarWidth).toBe(312)
    }
  }
})

it('elsewhere the list commands keep their behavior', () => {
  // Workspaces with the rail on, and a page with the rail off: Cmd+B toggles in place.
  setUp(true, true)
  handlers().get('sidebar.left.toggle')?.()
  expect(useAppStore.getState()).toMatchObject({ activeView: 'terminal', sidebarOpen: false })

  setUp(false, true)
  useAppStore.getState().openTaskPage()
  handlers().get('sidebar.left.toggle')?.()
  expect(useAppStore.getState()).toMatchObject({ activeView: 'tasks', sidebarOpen: false })

  // Settings: the board command is not claimed and fires nothing.
  setUp(true, true)
  useAppStore.setState({ activeView: 'settings' })
  let fired = 0
  const listener = (): void => {
    fired += 1
  }
  window.addEventListener(TOGGLE_WORKSPACE_BOARD_EVENT, listener)
  try {
    expect(handlers().get('workspace.openBoard')?.()).toBe(false)
  } finally {
    window.removeEventListener(TOGGLE_WORKSPACE_BOARD_EVENT, listener)
  }
  expect(fired).toBe(0)
})
