// @vitest-environment happy-dom

import { createElement, useSyncExternalStore } from 'react'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../../../../shared/agent-session/options/agent-session-option-catalog-types'

import { clearNativeChatSessionOptionCacheForTests } from '../../../../../../../shared/native-chat/input/native-chat-session-option-cache'
import { clearNativeChatModelEnrichmentForTests } from '../catalog/native-chat-session-option-enrichment'

const discoverModels = vi.fn<() => Promise<readonly CatalogModel[] | null>>()
const settingsRpc = vi.fn()
let currentConnectionId: string | null | undefined = null
let discoveryUnavailable = false

vi.mock('@/lib/workspace/ownership/connection-owner-resolution', () => ({
  getConnectionIdFromState: () => currentConnectionId
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (...args: unknown[]) => settingsRpc(...args)
}))

vi.mock('../catalog/native-chat-session-option-discovery', () => ({
  resolveNativeChatModelDiscoveryContext: () =>
    discoveryUnavailable
      ? null
      : {
          hostKey: 'host',
          runtime: { worktreeId: 'worktree-1' }
        },
  discoverNativeChatCatalogModels: () => discoverModels()
}))

const storeState: {
  tabsByWorktree: Record<string, { id: string; ptyId: string }[]>
  settings: Record<string, unknown>
  updateSettings: () => Promise<undefined>
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId: Record<string, string> }>
  agentStatusByPaneKey: Record<
    string,
    {
      agentType?: string
      model?: string
      modelSwitchCommand?: 'orca-model'
      terminalHandle?: string
      providerSession?: { key: 'session_id'; id: string }
    }
  >
} = {
  tabsByWorktree: { 'worktree-1': [{ id: 'tab-1', ptyId: 'pty-1' }] },
  settings: {},
  updateSettings: async () => undefined,
  terminalLayoutsByTabId: {},
  agentStatusByPaneKey: {}
}

const storeListeners = new Set<() => void>()
const subscribeStore = (listener: () => void): (() => void) => {
  storeListeners.add(listener)
  return () => {
    storeListeners.delete(listener)
  }
}

vi.mock('../../../../../store/index', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) =>
      useSyncExternalStore(subscribeStore, () => selector(storeState)),
    { getState: () => storeState }
  )
}))

import { useNativeChatSessionOptions } from './use-native-chat-session-options'

// The terminal reports resolved Opus while discovery lists its alias.
const CLAUDE_SCREEN =
  'Claude Code v2.1.220\r\nOpus 5 (1M context) with high effort · API Usage Billing\r\n~/repo'

const DISCOVERED: CatalogModel[] = [
  { id: 'opus[1m]', label: 'Opus (1M context)', options: [] },
  { id: 'haiku', label: 'Haiku', options: [] }
]

function modelDescriptor(snapshot: { id: string; kind: unknown }[]): {
  currentValue?: string
  choices: { value: string }[]
} {
  const model = snapshot.find((descriptor) => descriptor.id === 'model')
  return model?.kind as { currentValue?: string; choices: { value: string }[] }
}

describe('useNativeChatSessionOptions model reporting', () => {
  beforeEach(() => {
    clearNativeChatModelEnrichmentForTests()
    clearNativeChatSessionOptionCacheForTests()
    discoverModels.mockReset()
    settingsRpc.mockReset()
    settingsRpc.mockResolvedValue(undefined)
    currentConnectionId = null
    discoveryUnavailable = false
    storeState.agentStatusByPaneKey = {}
    storeState.terminalLayoutsByTabId = {}
    storeState.tabsByWorktree = { 'worktree-1': [{ id: 'tab-1', ptyId: 'pty-1' }] }
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  })

  it('re-resolves the reported model against models discovered after the read', async () => {
    // Async discovery must re-resolve the cached screen; the frame may have scrolled away before actual IDs arrive.
    let resolveDiscovery: (models: CatalogModel[]) => void = () => {}
    discoverModels.mockReturnValue(
      new Promise<readonly CatalogModel[]>((resolve) => {
        resolveDiscovery = resolve
      })
    )

    // Keep reader identity stable while the frame scrolls away to force cached-screen re-resolution.
    let frameVisible = true
    const readTerminalScreen = (): string | null =>
      frameVisible ? CLAUDE_SCREEN : 'conversation has scrolled past the frame'
    const dispatchCommand = vi.fn()

    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'tab-1',
        targetPtyId: 'pty-1',
        dispatchCommand,
        readTerminalScreen
      })
    )

    await waitFor(() => expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus'))

    frameVisible = false
    resolveDiscovery(DISCOVERED)

    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus[1m]')
    )
    expect(modelDescriptor(result.current.snapshot).choices.map((choice) => choice.value)).toEqual([
      'opus[1m]',
      'haiku'
    ])
  })

  it('does not re-resolve a late snapshot from the previous pty', async () => {
    let resolveDiscovery: (models: CatalogModel[]) => void = () => {}
    discoverModels.mockReturnValue(
      new Promise<readonly CatalogModel[]>((resolve) => {
        resolveDiscovery = resolve
      })
    )
    let resolveOldSnapshot: (snapshot: { data: string; alternateScreen: false }) => void = () => {}
    const oldSnapshot = new Promise<{ data: string; alternateScreen: false }>((resolve) => {
      resolveOldSnapshot = resolve
    })
    const getMainBufferSnapshot = vi
      .fn()
      .mockReturnValueOnce(oldSnapshot)
      .mockReturnValueOnce(new Promise(() => {}))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { pty: { getMainBufferSnapshot } }
    })

    const dispatchCommand = vi.fn()
    storeState.tabsByWorktree['worktree-1'][0].ptyId = 'pty-old'
    const { result, rerender } = renderHook(
      ({ targetPtyId }) =>
        useNativeChatSessionOptions({
          agent: 'claude',
          terminalTabId: 'tab-1',
          targetPtyId,
          dispatchCommand,
          readTerminalScreen: () => null
        }),
      { initialProps: { targetPtyId: 'pty-old' } }
    )

    storeState.tabsByWorktree['worktree-1'][0].ptyId = 'pty-new'
    rerender({ targetPtyId: 'pty-new' })
    resolveOldSnapshot({ data: CLAUDE_SCREEN, alternateScreen: false })
    await Promise.resolve()
    resolveDiscovery(DISCOVERED)

    await waitFor(() =>
      expect(
        modelDescriptor(result.current.snapshot).choices.map((choice) => choice.value)
      ).toEqual(['opus[1m]', 'haiku'])
    )
    expect(modelDescriptor(result.current.snapshot).currentValue).toBeUndefined()
  })
  it.each(['grok', 'claude'] as const)(
    'keeps an own %s pick through identity enrichment and resets for replacement',
    async (agent) => {
      discoverModels.mockResolvedValue(null)
      const paneKey = 'tab-1:00000000-0000-4000-8000-000000000001'
      storeState.terminalLayoutsByTabId['tab-1'] = {
        ptyIdsByLeafId: { [paneKey.split(':')[1]]: 'pty-1' }
      }
      storeState.agentStatusByPaneKey[paneKey] = { agentType: agent, model: 'grok-4.7' }
      const dispatchCommand = vi.fn()
      const readTerminalScreen = () => CLAUDE_SCREEN
      const { result, unmount } = renderHook(() =>
        useNativeChatSessionOptions({
          agent,
          terminalTabId: 'tab-1',
          targetPtyId: 'pty-1',
          paneKey,
          dispatchCommand,
          readTerminalScreen
        })
      )
      await act(async () => {
        await Promise.resolve()
      })
      const pick = agent === 'grok' ? 'grok-4.7-fast' : 'haiku'
      await act(async () => {
        await result.current.surface!.setOption('model', pick)
      })
      act(() => {
        storeState.agentStatusByPaneKey[paneKey] = {
          ...storeState.agentStatusByPaneKey[paneKey],
          terminalHandle: 'handle',
          providerSession: { key: 'session_id', id: 'A' }
        }
        for (const listener of storeListeners) {
          listener()
        }
      })
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe(pick)
      act(() => {
        storeState.agentStatusByPaneKey[paneKey] = {
          ...storeState.agentStatusByPaneKey[paneKey],
          providerSession: { key: 'session_id', id: 'B' }
        }
        for (const listener of storeListeners) {
          listener()
        }
      })
      await waitFor(() =>
        expect(modelDescriptor(result.current.snapshot).currentValue).toBe(
          agent === 'grok' ? 'grok-4.7' : 'opus'
        )
      )
      unmount()
    }
  )

  it.each(['A', 'B'])(
    'carries saved identity through a metadata gap and resolves session %s on the mounted hook',
    async (nextSession) => {
      discoverModels.mockResolvedValue(null)
      const paneKey = 'tab-1:00000000-0000-4000-8000-000000000001'
      storeState.terminalLayoutsByTabId['tab-1'] = {
        ptyIdsByLeafId: { [paneKey.split(':')[1]]: 'pty-1' }
      }
      storeState.agentStatusByPaneKey[paneKey] = {
        agentType: 'grok',
        providerSession: { key: 'session_id', id: 'A' }
      }
      const dispatchCommand = vi.fn()
      const mount = () =>
        renderHook(() =>
          useNativeChatSessionOptions({
            agent: 'grok',
            terminalTabId: 'tab-1',
            targetPtyId: 'pty-1',
            paneKey,
            dispatchCommand
          })
        )
      const first = mount()
      await act(async () => {
        await first.result.current.surface!.setOption('model', 'grok-4.7-fast')
      })
      first.unmount()
      storeState.agentStatusByPaneKey[paneKey] = { agentType: 'grok' }
      const reopened = mount()
      expect(modelDescriptor(reopened.result.current.snapshot).currentValue).toBe('grok-4.7-fast')
      act(() => {
        storeState.agentStatusByPaneKey[paneKey] = {
          agentType: 'grok',
          providerSession: { key: 'session_id', id: nextSession }
        }
        for (const listener of storeListeners) {
          listener()
        }
      })
      expect(modelDescriptor(reopened.result.current.snapshot).currentValue).toBe(
        nextSession === 'A' ? 'grok-4.7-fast' : 'grok-4.7'
      )
      if (nextSession === 'B') {
        expect(
          reopened.result.current.snapshot.find((descriptor) => descriptor.id === 'model')
            ?.valueSource
        ).toBe('default')
      }
      reopened.unmount()
    }
  )

  it('keeps the actual target usable when discovery is unavailable and ownership later resolves', async () => {
    discoveryUnavailable = true
    currentConnectionId = undefined
    storeState.tabsByWorktree = {}
    const dispatchCommand = vi.fn()
    const { result, rerender, unmount } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'grok',
        terminalTabId: 'tab-1',
        targetPtyId: 'pty-1',
        dispatchCommand
      })
    )
    storeState.tabsByWorktree = { 'worktree-1': [{ id: 'tab-1', ptyId: 'pty-1' }] }
    rerender()
    await act(async () => {
      await result.current.surface!.setOption('model', 'grok-4.7-fast')
    })
    currentConnectionId = null
    rerender()
    await act(async () => {
      await result.current.surface!.setOption('model', 'grok-4.7')
    })
    expect(dispatchCommand).toHaveBeenCalledTimes(2)
    expect(modelDescriptor(result.current.snapshot).currentValue).toBe('grok-4.7')
    unmount()
  })

  it.each([10, 100])('does not render unaffected model consumers among %i panes', async (count) => {
    discoverModels.mockResolvedValue(null)
    const dispatchCommand = vi.fn()
    const renders = Array.from({ length: count }, () => 0)
    const paneKey = (i: number): string =>
      `tab-${i}:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    storeState.tabsByWorktree['worktree-1'] = Array.from({ length: count }, (_, i) => ({
      id: `tab-${i}`,
      ptyId: `pty-${i}`
    }))
    for (let i = 0; i < count; i++) {
      storeState.terminalLayoutsByTabId[`tab-${i}`] = {
        ptyIdsByLeafId: { [paneKey(i).split(':')[1]]: `pty-${i}` }
      }
      storeState.agentStatusByPaneKey[paneKey(i)] = { agentType: 'grok' }
    }
    const seen: ReturnType<typeof useNativeChatSessionOptions>[] = []
    function Probe({ index }: { index: number }): null {
      renders[index]++
      seen[index] = useNativeChatSessionOptions({
        agent: 'grok',
        terminalTabId: `tab-${index}`,
        targetPtyId: `pty-${index}`,
        paneKey: paneKey(index),
        dispatchCommand
      })
      return null
    }
    const mounted = render(
      createElement(
        'div',
        null,
        ...renders.map((_, index) => createElement(Probe, { key: index, index }))
      )
    )
    await act(async () => {
      await Promise.resolve()
    })
    renders.fill(0)
    act(() => {
      storeState.agentStatusByPaneKey = {
        ...storeState.agentStatusByPaneKey,
        'other-host-pane': { agentType: 'grok', model: 'grok-4.7' }
      }
      for (const listener of storeListeners) {
        listener()
      }
    })
    expect(renders.every((count) => count === 0)).toBe(true)
    act(() => {
      storeState.agentStatusByPaneKey = {
        ...storeState.agentStatusByPaneKey,
        [paneKey(0)]: { agentType: 'grok', model: 'grok-4.7' }
      }
      for (const listener of storeListeners) {
        listener()
      }
    })
    expect(renders[0]).toBeGreaterThan(0)
    expect(modelDescriptor(seen[0].snapshot).currentValue).toBe('grok-4.7')
    expect(renders.slice(1).every((count) => count === 0)).toBe(true)
    mounted.unmount()
  })
})
