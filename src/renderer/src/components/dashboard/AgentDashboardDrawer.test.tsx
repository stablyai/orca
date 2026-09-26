// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => ({
  useLiveDashboardSnapshot: vi.fn(() => ({ generatedAt: 1, cards: [] })),
  blockingOverlay: false,
  boardProps: null as Record<string, unknown> | null,
  activateTabAndFocusPane: vi.fn(),
  activateAndRevealWorkspace: vi.fn(() => ({ primaryTabId: null }) as unknown),
  activateAndRevealWorktree: vi.fn(),
  activateStructuredAgentSessionById: vi.fn(() => false),
  activateStructuredAgentSessionTab: vi.fn(() => false),
  callRuntimeRpc: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: mocks.activateStructuredAgentSessionById,
  activateStructuredAgentSessionTab: mocks.activateStructuredAgentSessionTab
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    callRuntimeRpc: mocks.callRuntimeRpc
  }
})

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
    message: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    promise: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn()
  }
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
  mocks.activateTabAndFocusPane.mockClear()
  mocks.activateAndRevealWorkspace.mockClear()
  mocks.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: null })
  mocks.activateAndRevealWorktree.mockClear()
  mocks.activateStructuredAgentSessionById.mockReset().mockReturnValue(false)
  mocks.activateStructuredAgentSessionTab.mockReset().mockReturnValue(false)
  mocks.callRuntimeRpc.mockReset().mockRejectedValue(new Error('list failed'))
  mocks.toastError.mockReset()
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

  type RevealAgent = (args: {
    repoId: string
    worktreeId: string
    executionHostId?: string
    tabId: string
    leafId: string | null
  }) => void

  function revealFromBoard(executionHostId: string): void {
    render(<AgentDashboardDrawer statusBarVisible />)
    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))
    const onRevealAgent = mocks.boardProps?.onRevealAgent
    expect(onRevealAgent).toBeTypeOf('function')
    act(() => {
      ;(onRevealAgent as RevealAgent)({
        repoId: 'repo-1',
        worktreeId: 'shared-worktree',
        executionHostId,
        tabId: 'tab-1',
        leafId: 'leaf-1'
      })
    })
  }

  it('reveals a colliding worktree on the card execution host', () => {
    const setActiveWorktree = vi.spyOn(useAppStore.getState(), 'setActiveWorktree')

    revealFromBoard('runtime:env-1')

    // Bare setActiveWorktree skips the terminal view switch, initial-terminal seeding and
    // sleeping-session resume the shared dispatcher runs.
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('shared-worktree', {
      executionHostId: 'runtime:env-1'
    })
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab-1', 'leaf-1', {
      flashFocusedPane: true
    })
    expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false)
  })

  it('activates a parked SSH workspace before reaching for its pane', () => {
    revealFromBoard('ssh:devbox')

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('shared-worktree', {
      executionHostId: 'ssh:devbox'
    })
    // Ordering is the fix: a parked remote tab only exists after activation revives it.
    expect(mocks.activateAndRevealWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateTabAndFocusPane.mock.invocationCallOrder[0] as number
    )
  })

  it('skips pane focus when the revealed workspace is gone', () => {
    mocks.activateAndRevealWorkspace.mockReturnValue(false)

    revealFromBoard('ssh:devbox')

    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(true)
  })

  type StructuredReveal = {
    repoId: string
    worktreeId: string
    tabId: string
    leafId: null
    surfaceKind: 'structured-chat'
    structuredSessionId: string
  }

  function revealStructured(sessionId: string): void {
    render(<AgentDashboardDrawer statusBarVisible />)
    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))
    const onRevealAgent = mocks.boardProps?.onRevealAgent
    expect(onRevealAgent).toBeTypeOf('function')
    act(() => {
      ;(onRevealAgent as (args: StructuredReveal) => void)({
        repoId: 'repo-1',
        worktreeId: 'shared-worktree',
        tabId: 'tab-1',
        leafId: null,
        surfaceKind: 'structured-chat',
        structuredSessionId: sessionId
      })
    })
  }

  function installRevealReply(
    reply: { ok?: boolean; refusal?: { code?: string } } | 'unreachable'
  ): void {
    mocks.callRuntimeRpc.mockImplementation((...args: unknown[]) => {
      if (args[1] !== 'agentSession.reveal') {
        return Promise.reject(new Error('list failed'))
      }
      if (reply === 'unreachable') {
        return Promise.reject(new Error('offline'))
      }
      return Promise.resolve(reply)
    })
  }

  async function flushStructuredReveal(): Promise<void> {
    await waitFor(() => {
      expect(
        mocks.callRuntimeRpc.mock.calls.some((call) => call[1] === 'agentSession.reveal')
      ).toBe(true)
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  it('closes the drawer only after a host republish activates a local session', async () => {
    let resolveReveal: (reply: { ok: true }) => void = () => {}
    let activateCalls = 0
    mocks.activateStructuredAgentSessionById.mockImplementation(() => {
      activateCalls += 1
      // Why: a failed refresh skips the second lookup, so the third call is post-reveal.
      return activateCalls > 2
    })
    mocks.callRuntimeRpc.mockImplementation((...args: unknown[]) => {
      if (args[1] !== 'agentSession.reveal') {
        return Promise.reject(new Error('list failed'))
      }
      return new Promise((resolve) => {
        resolveReveal = resolve
      })
    })

    revealStructured('session-success')

    expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(true)
    await flushStructuredReveal()
    expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(true)
    expect(activateCalls).toBe(2)
    expect(mocks.toastError).not.toHaveBeenCalled()

    await act(async () => {
      resolveReveal({ ok: true })
    })
    await waitFor(() => {
      expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false)
    })
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each([
    {
      outcome: 'gone',
      sessionId: 'session-gone',
      reply: { ok: false, refusal: { code: 'agent_session_identity_required' } }
    },
    {
      outcome: 'host-cannot-open',
      sessionId: 'session-host-cannot-open',
      reply: { ok: false, refusal: { code: 'agent_session_unsupported' } }
    },
    {
      outcome: 'unreachable',
      sessionId: 'session-unreachable',
      reply: 'unreachable' as const
    },
    {
      outcome: 'activate-still-fails',
      sessionId: 'session-still-fails',
      reply: { ok: true }
    }
  ])(
    'keeps the drawer open when structured activation ends $outcome',
    async ({ sessionId, reply }) => {
      installRevealReply(reply)
      revealStructured(sessionId)
      await waitFor(() => {
        expect(mocks.toastError).toHaveBeenCalled()
      })
      expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(true)
      expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    }
  )
})
