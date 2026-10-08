import { useDialogRegistry } from '@/store/dialog-registry'
import { resetDialogRegistryForTests } from '@/store/dialog-registry-test-state'
// @vitest-environment happy-dom
import type { AppState } from '@/store/types'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  focus: vi.fn(),
  getState: vi.fn(),
  subscribe: vi.fn()
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({ focusRuntimeTerminalSurface: mocks.focus }))
vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState, subscribe: mocks.subscribe }
}))

import { queueWorkspaceActivationTerminalFocus } from './workspace-activation-terminal-focus'

let state: Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'activeView'
  | 'activeTabType'
  | 'activeTabId'
  | 'activeModal'
>
let frame: FrameRequestCallback | null
let notifyStore: () => void
let notifyMount: () => void
const unsubscribe = vi.fn()
const disconnect = vi.fn()

function flushFrame(): void {
  const callback = frame
  frame = null
  callback?.(0)
}

beforeEach(() => {
  resetDialogRegistryForTests({ startupSettled: true })
  vi.clearAllMocks()
  vi.useFakeTimers()
  frame = null
  state = {
    activeWorktreeId: 'wt-1',
    activeWorkspaceExecutionHostId: null,
    activeView: 'terminal',
    activeTabType: 'terminal',
    activeTabId: 'tab-1',
    activeModal: 'none'
  }
  mocks.getState.mockImplementation(() => state)
  mocks.subscribe.mockImplementation((listener) => {
    notifyStore = listener
    return unsubscribe
  })
  mocks.focus.mockReturnValue(false)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    frame = null
  })
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(callback: () => void) {
        notifyMount = callback
      }
      observe = vi.fn()
      disconnect = disconnect
    }
  )
})
afterEach(() => {
  document.dispatchEvent(new Event('pointerdown'))
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('workspace activation focus', () => {
  it('focuses an existing terminal after the palette closes and cleans up', () => {
    mocks.focus.mockReturnValue(true)
    expect(queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: 'tab-1' })).toBe(true)
    expect(mocks.focus).not.toHaveBeenCalled()
    flushFrame()
    expect(mocks.focus).toHaveBeenCalledWith('tab-1', null, 'wt-1')
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for a sleeping terminal to mount instead of focusing another workspace', () => {
    queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: null })
    flushFrame()
    expect(mocks.focus).toHaveBeenCalledTimes(1)
    expect(frame).toBeNull()
    mocks.focus.mockReturnValue(true)
    notifyMount()
    flushFrame()
    expect(mocks.focus).toHaveBeenLastCalledWith('tab-1', null, 'wt-1')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('claims a workspace whose terminal tab is created asynchronously', () => {
    state.activeTabId = null
    expect(queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: null })).toBe(true)
    flushFrame()
    expect(mocks.focus).not.toHaveBeenCalled()
    state.activeTabId = 'restored-tab'
    notifyStore()
    flushFrame()
    mocks.focus.mockReturnValue(true)
    notifyMount()
    flushFrame()
    expect(mocks.focus).toHaveBeenLastCalledWith('restored-tab', null, 'wt-1')
  })

  it.each([
    { activeWorktreeId: 'wt-2' },
    { activeWorkspaceExecutionHostId: 'ssh:second-host' },
    { activeView: 'settings' },
    { activeTabType: 'browser' },
    { activeTabId: 'tab-2' }
  ] as const)('cancels when selection changes to %j during restoration', (change) => {
    queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: 'tab-1' })
    flushFrame()
    mocks.focus.mockClear()
    state = { ...state, ...change }
    notifyStore()
    flushFrame()
    notifyMount()
    flushFrame()
    expect(mocks.focus).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('cancels on a user click while waiting', () => {
    queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: 'tab-1' })
    flushFrame()
    document.dispatchEvent(new Event('pointerdown'))
    mocks.focus.mockClear()
    notifyMount()
    flushFrame()
    expect(mocks.focus).not.toHaveBeenCalled()
  })

  it('does not steal focus from an input claimed during restoration', () => {
    queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: 'tab-1' })
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    notifyMount()
    flushFrame()
    expect(mocks.focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })

  it('retains focus through composer dialog close with a previously focused editable input', async () => {
    const previousInput = document.createElement('input')
    const container = document.createElement('div')
    document.body.append(previousInput, container)
    previousInput.focus()
    const root = createRoot(container)
    try {
      // The composer uses a controlled modal without a DialogTrigger or close autofocus handler.
      await act(async () => {
        root.render(
          createElement(
            Dialog,
            { open: true },
            createElement(
              DialogContent,
              { 'aria-describedby': undefined },
              createElement(DialogTitle, null, 'New workspace'),
              createElement('input', { 'aria-label': 'Workspace name' })
            )
          )
        )
      })
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Workspace name')
      queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: 'tab-1' })
      await act(async () => root.render(null))
      await act(async () => vi.advanceTimersByTime(0))
      expect(previousInput.isConnected).toBe(true)
      expect(document.activeElement).not.toBe(previousInput)
      mocks.focus.mockReturnValue(true)
      flushFrame()
      expect(mocks.focus).toHaveBeenCalledWith('tab-1', null, 'wt-1')
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('keeps the post-palette request when terminal mounting briefly takes focus', () => {
    queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: 'tab-1' })
    const textarea = document.createElement('textarea')
    textarea.className = 'xterm-helper-textarea'
    document.body.append(textarea)
    textarea.focus()
    textarea.blur()
    mocks.focus.mockReturnValue(true)
    flushFrame()
    expect(mocks.focus).toHaveBeenCalledWith('tab-1', null, 'wt-1')
  })

  it('expires a request if restoration fails', () => {
    queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: 'tab-1' })
    vi.advanceTimersByTime(30_000)
    notifyMount()
    flushFrame()
    expect(mocks.focus).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('cancels the previous request when a new activation is declined', () => {
    queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: 'tab-1' })
    state.activeTabType = 'browser'
    expect(queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: null })).toBe(false)
    notifyMount()
    flushFrame()
    expect(mocks.focus).not.toHaveBeenCalled()
  })

  it('declines a failed activation', () => {
    expect(queueWorkspaceActivationTerminalFocus('wt-1', false)).toBe(false)
    expect(mocks.subscribe).not.toHaveBeenCalled()
  })
})

it('a closing palette keeps its selected terminal focus request until content leaves', () => {
  const registry = useDialogRegistry.getState()
  registry.dialogContentMounted('palette')
  registry.closeDialog('palette')
  queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: 'tab-1' })
  flushFrame()
  expect(mocks.focus).not.toHaveBeenCalled()
  expect(unsubscribe).not.toHaveBeenCalled()
  registry.dialogContentUnmounted('palette')
  mocks.focus.mockReturnValue(true)
  notifyMount()
  flushFrame()
  expect(mocks.focus).toHaveBeenCalledWith('tab-1', null, 'wt-1')
})

it('a live dialog prevents terminal focus while preserving the request', () => {
  useDialogRegistry.getState().dialogContentMounted('tip')
  queueWorkspaceActivationTerminalFocus('wt-1', { primaryTabId: 'tab-1' })
  flushFrame()
  expect(mocks.focus).not.toHaveBeenCalled()
  document.dispatchEvent(new Event('pointerdown'))
  useDialogRegistry.getState().dialogContentUnmounted('tip')
  notifyMount()
  flushFrame()
  expect(mocks.focus).not.toHaveBeenCalled()
})
