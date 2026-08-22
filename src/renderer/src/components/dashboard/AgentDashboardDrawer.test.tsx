// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => ({
  useLiveDashboardSnapshot: vi.fn(() => ({ generatedAt: 1, cards: [] })),
  blockingOverlay: false,
  boardProps: null as Record<string, unknown> | null,
  activateTabAndFocusPane: vi.fn()
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))

vi.mock('./useLiveDashboardSnapshot', () => ({
  useLiveDashboardSnapshot: mocks.useLiveDashboardSnapshot
}))

vi.mock('../dashboard-popout/AgentKanbanBoard', () => ({
  AgentKanbanBoard: (props: Record<string, unknown>) => {
    mocks.boardProps = props
    return mocks.blockingOverlay ? <section role="dialog" data-state="open" /> : null
  }
}))

vi.mock('./AgentDashboardSettingsMenu', () => ({
  AgentDashboardSettingsMenu: () => null
}))

vi.mock('../sidebar/use-workspace-kanban-outside-dismiss', () => ({
  isWorkspaceBoardKeepOpenTarget: () => false,
  useWorkspaceKanbanOutsideDismiss: () => undefined
}))

import { AgentDashboardDrawer } from './AgentDashboardDrawer'

const initialState = useAppStore.getInitialState()

beforeEach(() => {
  useAppStore.setState(
    {
      agentDashboardDrawerOpen: false,
      sidebarOpen: true,
      sidebarWidth: 320
    },
    false
  )
  mocks.useLiveDashboardSnapshot.mockClear()
  mocks.blockingOverlay = false
  mocks.boardProps = null
  ;(window as unknown as { api: unknown }).api = {
    dashboard: { openPopout: vi.fn().mockResolvedValue(undefined) }
  }
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('AgentDashboardDrawer', () => {
  it('derives no dashboard snapshot while closed', () => {
    render(<AgentDashboardDrawer statusBarVisible />)

    expect(mocks.useLiveDashboardSnapshot).not.toHaveBeenCalled()

    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))
    expect(mocks.useLiveDashboardSnapshot).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to an open terminal panel before dismissing the drawer', () => {
    mocks.blockingOverlay = true
    const view = render(<AgentDashboardDrawer statusBarVisible />)

    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(true)

    mocks.blockingOverlay = false
    view.rerender(<AgentDashboardDrawer statusBarVisible />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false)
  })

  it('does not hand the drawer over to an agent map popout', () => {
    render(<AgentDashboardDrawer statusBarVisible />)
    expect(mocks.boardProps).toBeNull()

    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))
    expect(mocks.boardProps).not.toBeNull()
    expect(mocks.boardProps?.onOpenMap).toBeUndefined()
    expect(mocks.boardProps?.initialView).toBeUndefined()
  })

  it('reveals a colliding worktree on the card execution host', () => {
    const setActiveWorktree = vi.spyOn(useAppStore.getState(), 'setActiveWorktree')
    render(<AgentDashboardDrawer statusBarVisible />)
    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))
    const onRevealAgent = mocks.boardProps?.onRevealAgent
    expect(onRevealAgent).toBeTypeOf('function')

    act(() => {
      ;(
        onRevealAgent as (args: {
          repoId: string
          worktreeId: string
          executionHostId?: string
          tabId: string
          leafId: string | null
        }) => void
      )({
        repoId: 'repo-1',
        worktreeId: 'shared-worktree',
        executionHostId: 'runtime:env-1',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      })
    })

    expect(setActiveWorktree).toHaveBeenCalledWith('shared-worktree', 'runtime:env-1')
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab-1', 'leaf-1', {
      flashFocusedPane: true
    })
  })
})
