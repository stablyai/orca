import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StoreApi, type UseBoundStore } from 'zustand'

type BridgeState = {
  detachedTerminalByTabId: Record<string, { ptyId: string }>
  agentStatusByPaneKey: Record<string, string>
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

import { publishDetachedTerminalInputs } from './detached-terminal-ipc-bridge'

let appStore: BridgeStore

describe('detached terminal input publishing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appStore = create<BridgeState>(() => ({
      detachedTerminalByTabId: {},
      agentStatusByPaneKey: {},
      unrelated: 0
    }))
    store.current = appStore
  })

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
