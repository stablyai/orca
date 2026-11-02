import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

type BridgeState = {
  detachedTerminalByTabId: Record<string, { ptyId: string }>
  agentStatusByPaneKey: Record<string, string>
  tabsByWorktree: Record<string, { id: string; ptyId: string | null; title: string }[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  closeDetachedTerminalWindow: (tabId: string) => void
  unrelated: number
}

type BridgeStore = UseBoundStore<StoreApi<BridgeState>>

const { store, resolveInput } = vi.hoisted(() => {
  const holder: { current?: BridgeStore } = {}
  return {
    store: holder,
    resolveInput: vi.fn((state: BridgeState, tabId: string) => ({
      tabId,
      agent: state.agentStatusByPaneKey[tabId] ?? null
    }))
  }
})

vi.mock('../../store', () => ({
  get useAppStore() {
    return store.current
  }
}))
vi.mock('../../store/terminals/detached-terminal-input', () => ({
  resolveDetachedTerminalInput: resolveInput
}))

import {
  closeStaleDetachedTerminals,
  publishDetachedTerminalInputs
} from './detached-terminal-ipc-bridge'

let appStore: BridgeStore

beforeEach(() => {
  vi.clearAllMocks()
  appStore = create<BridgeState>((set) => ({
    detachedTerminalByTabId: {},
    agentStatusByPaneKey: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    closeDetachedTerminalWindow: vi.fn(() => set({ detachedTerminalByTabId: {} })),
    unrelated: 0
  }))
  store.current = appStore
})

describe('detached terminal input publishing', () => {
  it('sends a companion its facts once, then only when they change', () => {
    const send = vi.fn()
    const stop = publishDetachedTerminalInputs(send)
    const { setState } = appStore

    setState({ detachedTerminalByTabId: { 'tab-1': { ptyId: 'pty-1' } } })
    setState({ unrelated: 1 })
    setState({ agentStatusByPaneKey: {} })
    setState({ agentStatusByPaneKey: { 'tab-1': 'claude' } })

    expect(send.mock.calls).toEqual([
      ['tab-1', { tabId: 'tab-1', agent: null }],
      ['tab-1', { tabId: 'tab-1', agent: 'claude' }]
    ])
    // An unrelated store update never re-resolves the facts.
    expect(resolveInput).toHaveBeenCalledTimes(3)
    stop()
  })

  it('sends again after the tab is re-docked and detached anew', () => {
    const send = vi.fn()
    const stop = publishDetachedTerminalInputs(send)
    const { setState } = appStore

    setState({ detachedTerminalByTabId: { 'tab-1': { ptyId: 'pty-1' } } })
    setState({ detachedTerminalByTabId: {} })
    setState({ detachedTerminalByTabId: { 'tab-1': { ptyId: 'pty-1' } } })

    expect(send).toHaveBeenCalledTimes(2)
    stop()
  })
})

function layoutWith(ptyIdsByLeafId: Record<string, string>): TerminalLayoutSnapshot {
  return { root: null, activeLeafId: 'leaf-1', expandedLeafId: null, ptyIdsByLeafId }
}

describe('stale detached terminal windows', () => {
  beforeEach(() => {
    appStore.setState({
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', title: 'Terminal' }] },
      terminalLayoutsByTabId: { 'tab-1': layoutWith({ 'leaf-1': 'pty-1' }) },
      detachedTerminalByTabId: { 'tab-1': { ptyId: 'pty-1' } }
    })
  })

  it('re-docks a tab once its pane binds another PTY', () => {
    const stop = closeStaleDetachedTerminals()

    appStore.setState({
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-2', title: 'Terminal' }] },
      terminalLayoutsByTabId: { 'tab-1': layoutWith({ 'leaf-1': 'pty-2' }) }
    })

    expect(appStore.getState().closeDetachedTerminalWindow).toHaveBeenCalledExactlyOnceWith('tab-1')
    expect(appStore.getState().detachedTerminalByTabId).toEqual({})
    stop()
  })

  it('re-docks a tab that splits, since the window shows one pane', () => {
    const stop = closeStaleDetachedTerminals()

    appStore.setState({
      terminalLayoutsByTabId: { 'tab-1': layoutWith({ 'leaf-1': 'pty-1', 'leaf-2': 'pty-3' }) }
    })

    expect(appStore.getState().closeDetachedTerminalWindow).toHaveBeenCalledExactlyOnceWith('tab-1')
    stop()
  })

  it('keeps the window while its PTY stays bound or the pane has none yet', () => {
    const stop = closeStaleDetachedTerminals()

    appStore.setState({ unrelated: 1 })
    appStore.setState({
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', title: 'Renamed' }] }
    })
    appStore.setState({
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null, title: 'Renamed' }] },
      terminalLayoutsByTabId: { 'tab-1': layoutWith({}) }
    })

    expect(appStore.getState().closeDetachedTerminalWindow).not.toHaveBeenCalled()
    stop()
  })
})
