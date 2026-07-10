import { beforeEach, describe, expect, it, vi } from 'vitest'

const focusTerminalTabSurfaceMock = vi.hoisted(() => vi.fn())
const focusRuntimeTerminalSurfaceMock = vi.hoisted(() => vi.fn())
const getStateMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: focusTerminalTabSurfaceMock
}))

vi.mock('@/runtime/sync-runtime-graph', () => ({
  focusRuntimeTerminalSurface: focusRuntimeTerminalSurfaceMock
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

import { queueNewWorkspaceTerminalFocus } from './new-workspace-terminal-focus'

type FocusState = {
  activeWorktreeId: string | null
  activeView: string
  activeTabType: string
  activeTabId: string | null
}

let pendingFrame: (() => void) | null = null

function setFocusState(state: FocusState): void {
  getStateMock.mockImplementation(() => state)
}

function flushFrame(): void {
  const frame = pendingFrame
  pendingFrame = null
  frame?.()
}

describe('queueNewWorkspaceTerminalFocus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pendingFrame = null
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      pendingFrame = () => callback(0)
      return 1
    })
    focusRuntimeTerminalSurfaceMock.mockReturnValue(false)
  })

  it('focuses the primary tab from the activation result after the modal close frame', () => {
    setFocusState({
      activeWorktreeId: 'wt-1',
      activeView: 'terminal',
      activeTabType: 'terminal',
      activeTabId: 'tab-1'
    })

    queueNewWorkspaceTerminalFocus('wt-1', { primaryTabId: 'tab-1' })

    expect(focusRuntimeTerminalSurfaceMock).not.toHaveBeenCalled()
    flushFrame()

    expect(focusRuntimeTerminalSurfaceMock).toHaveBeenCalledWith('tab-1')
    expect(focusTerminalTabSurfaceMock).toHaveBeenCalledWith('tab-1')
  })

  it('uses the adopted active terminal tab when activation did not create one', () => {
    setFocusState({
      activeWorktreeId: 'wt-1',
      activeView: 'terminal',
      activeTabType: 'terminal',
      activeTabId: 'tab-adopted'
    })

    queueNewWorkspaceTerminalFocus('wt-1', { primaryTabId: null })
    flushFrame()

    expect(focusRuntimeTerminalSurfaceMock).toHaveBeenCalledWith('tab-adopted')
    expect(focusTerminalTabSurfaceMock).toHaveBeenCalledWith('tab-adopted')
  })

  it('does not fall back to DOM focus when the runtime surface handled focus', () => {
    focusRuntimeTerminalSurfaceMock.mockReturnValue(true)
    setFocusState({
      activeWorktreeId: 'wt-1',
      activeView: 'terminal',
      activeTabType: 'terminal',
      activeTabId: 'tab-1'
    })

    queueNewWorkspaceTerminalFocus('wt-1', { primaryTabId: 'tab-1' })
    flushFrame()

    expect(focusRuntimeTerminalSurfaceMock).toHaveBeenCalledWith('tab-1')
    expect(focusTerminalTabSurfaceMock).not.toHaveBeenCalled()
  })

  it('does not steal focus if the user leaves the created workspace first', () => {
    const state: FocusState = {
      activeWorktreeId: 'wt-1',
      activeView: 'terminal',
      activeTabType: 'terminal',
      activeTabId: 'tab-1'
    }
    setFocusState(state)

    queueNewWorkspaceTerminalFocus('wt-1', { primaryTabId: 'tab-1' })
    state.activeWorktreeId = 'wt-2'
    flushFrame()

    expect(focusRuntimeTerminalSurfaceMock).not.toHaveBeenCalled()
    expect(focusTerminalTabSurfaceMock).not.toHaveBeenCalled()
  })
})
