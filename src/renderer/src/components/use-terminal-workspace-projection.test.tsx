// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { deriveActiveSurfaceForWorktree } from '@/store/slices/tabs/tabs-surface'
import { useTerminalWorkspaceFoundation } from './use-terminal-workspace-foundation'
import { useTerminalWorkspaceStoreBindings } from './use-terminal-workspace-store-bindings'
import { useTerminalWorkspaceProjection } from './use-terminal-workspace-projection'

vi.mock('./terminal/use-terminal-provider-snapshot-capability', () => ({
  useTerminalProviderSnapshotCapability: () => 0
}))

const initialState = useAppStore.getState()
const initialApi = window.api
let root: Root
let container: HTMLDivElement

function Probe() {
  const foundation = useTerminalWorkspaceFoundation()
  const bindings = useTerminalWorkspaceStoreBindings(foundation)
  useTerminalWorkspaceProjection({ ...foundation, ...bindings })
  return null
}

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  Reflect.set(window, 'api', { ui: { set: vi.fn().mockResolvedValue(undefined) } })
  useAppStore.setState(initialState, true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
  Reflect.set(window, 'api', initialApi)
})

it.each(['worktree-chat', 'folder:project'])(
  'starts a tour for chat-only %s',
  async (workspace) => {
    useAppStore.setState({ activeWorktreeId: workspace, activeView: 'terminal' })
    useAppStore.getState().createUnifiedTab(workspace, 'agent-session', {
      id: 'agent-session:chat',
      entityId: 'chat',
      agentSessionAgent: 'codex'
    })
    useAppStore.setState(deriveActiveSurfaceForWorktree(useAppStore.getState(), workspace))
    useAppStore.setState({
      workspaceSessionReady: true,
      persistedUIReady: true,
      contextualToursAutoEligible: true,
      contextualToursOnboardingVisible: false,
      contextualToursBlockingSurfaceVisible: false,
      activeModal: 'none'
    })
    expect(useAppStore.getState().activeTabType).toBe('agent-session')
    expect(useAppStore.getState().activeTabId).toBeNull()
    const target = document.createElement('button')
    target.dataset.contextualTourTarget = 'tab-create-menu'
    target.getBoundingClientRect = () => new DOMRect(0, 0, 20, 20)
    document.body.appendChild(target)

    await act(async () => {
      root.render(<Probe />)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(useAppStore.getState().activeContextualTourId).toBe('workspace-agent-sessions')
    expect(useAppStore.getState().activeContextualTourSuppressed).toBe(false)
  }
)
