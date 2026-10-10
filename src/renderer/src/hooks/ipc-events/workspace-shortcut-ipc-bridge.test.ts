// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useSidebarAgentIndexShortcut } from '@/components/sidebar/use-sidebar-agent-index-shortcut'
import {
  makeActivityResult,
  makeThreads,
  makeWorkingEntryWithoutHistory,
  PANE_KEY
} from '@/components/activity/ActivityPrototypePage-test-fixtures'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { subscribeCmdJRowIndexJump } from '@/lib/cmd-j-row-index-jump'
import { registerWorkspaceShortcutIpcBridge } from './workspace-shortcut-ipc-bridge'

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: vi.fn() }))
vi.mock('@/components/sidebar/visible-worktrees', () => ({
  getVisibleWorktreeShortcutTargets: () => [{ id: 'workspace', executionHostId: 'ssh:host' }]
}))

let jump: (index: number) => void
const unsubs: (() => void)[] = []

beforeEach(() => {
  useAppStore.setState({
    activeView: 'terminal',
    activeModal: 'none',
    sidebarOpen: true,
    sidebarBody: 'agents'
  })
  vi.stubGlobal('api', {
    ui: new Proxy(
      {},
      {
        get: (_target, key) => (listener: (index: number) => void) => {
          if (key === 'onJumpToWorktreeIndex') {
            jump = listener
          }
          return () => {}
        }
      }
    )
  })
  registerWorkspaceShortcutIpcBridge(unsubs)
})

afterEach(() => {
  cleanup()
  unsubs.splice(0).forEach((unsubscribe) => unsubscribe())
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('routes digits to the displayed Agents list without revealing a hidden workspace', () => {
  const listener = vi.fn()
  window.addEventListener('orca:sidebar-agent-index-jump', listener)
  try {
    jump(0)
    expect(listener).toHaveBeenCalledOnce()
    expect((listener.mock.calls[0][0] as CustomEvent<number>).detail).toBe(0)
    expect(activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(useAppStore.getState().sidebarBody).toBe('agents')
  } finally {
    window.removeEventListener('orca:sidebar-agent-index-jump', listener)
  }
})

it.each([{ sidebarBody: 'workspaces' as const }, { sidebarOpen: false }])(
  'preserves workspace navigation when Agents are not displayed: %o',
  (state) => {
    useAppStore.setState(state)
    jump(0)
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('workspace', {
      executionHostId: 'ssh:host'
    })
  }
)

it('delivers the IPC index through the mounted activity hook to its selection callback', () => {
  const threads = makeThreads(
    makeActivityResult({ entries: { [PANE_KEY]: makeWorkingEntryWithoutHistory() } })
  )
  const select = vi.fn()
  renderHook(() =>
    useSidebarAgentIndexShortcut([{ key: 'all', label: '', threads }], 'none', select)
  )
  act(() => jump(0))
  expect(threads).toHaveLength(1)
  expect(select).toHaveBeenCalledExactlyOnceWith(threads[0])
  expect(activateAndRevealWorkspace).not.toHaveBeenCalled()
})

it('keeps the command palette ahead of sidebar navigation', () => {
  const listener = vi.fn()
  unsubs.push(subscribeCmdJRowIndexJump(listener))
  useAppStore.setState({ activeModal: 'worktree-palette' })
  jump(1)
  expect(listener).toHaveBeenCalledWith(1)
  expect(activateAndRevealWorkspace).not.toHaveBeenCalled()
})

it('does not navigate behind a non-terminal view', () => {
  useAppStore.setState({ activeView: 'settings' })
  jump(0)
  expect(activateAndRevealWorkspace).not.toHaveBeenCalled()
})
