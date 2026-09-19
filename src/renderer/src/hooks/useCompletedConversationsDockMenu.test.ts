// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCompletedConversationsDockMenu } from './useCompletedConversationsDockMenu'

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  activate: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  setSelection: vi.fn(),
  openActivity: vi.fn(),
  setMenu: vi.fn(),
  onOpen: vi.fn(),
  stopOpen: vi.fn(),
  acknowledge: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      setSelectedActivityPaneKey: mocks.setSelection,
      openActivityPage: mocks.openActivity,
      acknowledgeAgents: mocks.acknowledge
    }),
    subscribe: mocks.subscribe
  }
}))
vi.mock('@/lib/completed-agent-conversations', () => ({
  createCompletedConversationsSelector: () => mocks.select
}))
vi.mock('@/components/activity/activity-thread-actions', () => ({
  activateActivityThreadTarget: mocks.activate
}))

describe('Dock conversation synchronization and navigation', () => {
  const entries = [{ id: 'turn-1', label: 'Workspace — Task' }]
  const thread = { paneKey: 'pane-1' }
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('navigator', { userAgent: 'Mac' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        app: {
          setDockCompletedConversations: mocks.setMenu,
          onOpenDockCompletedConversation: mocks.onOpen
        }
      }
    })
    mocks.setMenu.mockResolvedValue(undefined)
    mocks.subscribe.mockReturnValue(mocks.unsubscribe)
    mocks.onOpen.mockReturnValue(mocks.stopOpen)
    mocks.select.mockReturnValue({ entries, threads: new Map([['turn-1', thread]]) })
    mocks.activate.mockReturnValue(true)
  })
  afterEach(() => {
    delete window.__ORCA_WEB_CLIENT__
    vi.unstubAllGlobals()
  })

  it('coalesces updates, preserves snapshots and releases every subscription', async () => {
    const hook = renderHook(useCompletedConversationsDockMenu)
    expect(mocks.setMenu).toHaveBeenCalledWith(entries)
    const changed = mocks.subscribe.mock.calls[0][0]
    const finalEntries = [{ id: 'turn-2', label: 'Workspace — Final task' }]
    mocks.select.mockReturnValueOnce({ entries: finalEntries, threads: new Map() })
    await act(async () => {
      changed()
      changed()
    })
    expect(mocks.setMenu).toHaveBeenCalledTimes(2)
    expect(mocks.setMenu).toHaveBeenLastCalledWith(finalEntries)
    mocks.select.mockReturnValue({ entries: [], threads: new Map() })
    await act(async () => {
      changed()
    })
    expect(mocks.setMenu).toHaveBeenLastCalledWith([])
    hook.unmount()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
    expect(mocks.stopOpen).toHaveBeenCalledOnce()
  })

  it('resolves the latest turn before navigating and leaves acknowledgement to the viewed surface', () => {
    const hook = renderHook(useCompletedConversationsDockMenu)
    const open = mocks.onOpen.mock.calls[0][0]
    open('turn-1')
    expect(mocks.activate).toHaveBeenCalledWith(thread, { providesInitialSurface: true })
    expect(mocks.acknowledge).not.toHaveBeenCalled()
    mocks.select.mockReturnValue({ entries: [], threads: new Map() })
    open('turn-1')
    expect(mocks.activate).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it('opens retained details when the terminal is no longer available', () => {
    mocks.activate.mockReturnValue(false)
    const hook = renderHook(useCompletedConversationsDockMenu)
    mocks.onOpen.mock.calls[0][0]('turn-1')
    expect(mocks.setSelection).toHaveBeenCalledWith('pane-1')
    expect(mocks.openActivity).toHaveBeenCalledOnce()
    expect(mocks.acknowledge).not.toHaveBeenCalled()
    hook.unmount()
  })

  it.each(['Windows', 'Linux'])('does not subscribe on %s', (userAgent) => {
    vi.stubGlobal('navigator', { userAgent })
    const hook = renderHook(useCompletedConversationsDockMenu)
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.setMenu).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('does not subscribe in the web client on macOS', () => {
    window.__ORCA_WEB_CLIENT__ = true
    const hook = renderHook(useCompletedConversationsDockMenu)
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.setMenu).not.toHaveBeenCalled()
    hook.unmount()
  })
})
