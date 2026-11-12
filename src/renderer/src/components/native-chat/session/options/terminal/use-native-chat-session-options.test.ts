// @vitest-environment happy-dom
import type * as TerminalDiscovery from '@/runtime/terminal/terminal-model-discovery-client'

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../../../../shared/agent-session/options/agent-session-option-catalog-types'

import { clearNativeChatModelEnrichmentForTests } from '../catalog/native-chat-session-option-enrichment'

const discoverModels = vi.fn<() => Promise<readonly CatalogModel[] | null>>()
const settingsRpc = vi.fn()
const terminalCatalog = vi.fn()
const discoveryContext = vi.fn((terminalTabId: string) => ({
  hostKey: 'host',
  runtime: {
    target: { kind: 'local' as const },
    worktreeId: terminalTabId,
    worktreePath: '/repo'
  }
}))
vi.mock('@/runtime/terminal/terminal-model-discovery-client', async (original) => ({
  ...(await original<typeof TerminalDiscovery>()),
  readAntigravityTerminalCatalog: (context: unknown) => terminalCatalog(context)
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (...args: unknown[]) => settingsRpc(...args)
}))

vi.mock('../catalog/native-chat-session-option-discovery', () => ({
  resolveNativeChatModelDiscoveryContext: (terminalTabId: string) =>
    discoveryContext(terminalTabId),
  resolveWorktreeModelDiscoveryRuntime: (_state: unknown, id: string) =>
    discoveryContext(id).runtime,
  discoverNativeChatCatalogModels: () => discoverModels()
}))

const storeListeners = new Set<(state: typeof storeState, previous: typeof storeState) => void>()
const storeState: {
  settings: Record<string, unknown>
  tabsByWorktree: Record<string, { id: string }[]>
  updateSettings: () => Promise<undefined>
  agentStatusByPaneKey: Record<string, { model?: string; modelSwitchCommand?: 'orca-model' }>
} = {
  settings: {},
  tabsByWorktree: { 'agy-tab': [{ id: 'agy-tab' }], 'open-context': [{ id: 'open-context' }] },
  updateSettings: async () => undefined,
  agentStatusByPaneKey: {}
}

vi.mock('../../../../../store/index', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    {
      getState: () => storeState,
      subscribe: (listener: (state: typeof storeState, previous: typeof storeState) => void) => {
        storeListeners.add(listener)
        return () => storeListeners.delete(listener)
      }
    }
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
    discoverModels.mockReset()
    settingsRpc.mockReset()
    settingsRpc.mockResolvedValue(undefined)
    storeState.agentStatusByPaneKey = {}
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
})

it.each([1, 10])(
  'does no discovery for %i mounted Antigravity panes without an open picker',
  async (count) => {
    terminalCatalog.mockClear()
    const panes = Array.from({ length: count }, (_, index) =>
      renderHook(() =>
        useNativeChatSessionOptions({
          agent: 'antigravity',
          terminalTabId: `hidden-${count}-${index}`,
          targetPtyId: `hidden-pty-${count}-${index}`,
          dispatchCommand: vi.fn()
        })
      )
    )
    try {
      await act(async () => {})
      expect(terminalCatalog).not.toHaveBeenCalled()
    } finally {
      panes.forEach(({ unmount }) => unmount())
    }
  }
)

it('refreshes live Antigravity efforts only on picker demand, preserving choices across callback changes', async () => {
  const { groupAntigravityModelEfforts } =
    await import('../../../../../../../shared/agent-session/options/antigravity-model-efforts')
  const models = groupAntigravityModelEfforts([
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' }
  ])
  terminalCatalog.mockReset().mockResolvedValue({ origin: 'probe', fetchedAt: 1, models })
  storeState.agentStatusByPaneKey = { 'agy-pane': { model: 'gemini-3.8-flash-medium' } }
  const dispatchCommand = vi.fn()
  const { result, unmount, rerender } = renderHook(
    ({ dispatchCommand }) =>
      useNativeChatSessionOptions({
        agent: 'antigravity',
        terminalTabId: 'agy-tab',
        targetPtyId: 'agy-pty',
        paneKey: 'agy-pane',
        dispatchCommand
      }),
    { initialProps: { dispatchCommand } }
  )
  expect(terminalCatalog).not.toHaveBeenCalled()
  act(() => {
    result.current.surface?.demandModelCatalog?.()
  })
  await waitFor(() =>
    expect(result.current.snapshot.find(({ id }) => id === 'effort')?.kind).toMatchObject({
      choices: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]
    })
  )
  expect(terminalCatalog).toHaveBeenCalledTimes(1)
  expect(modelDescriptor(result.current.snapshot).currentValue).toBe('gemini-3.8-flash-medium')
  settingsRpc.mockClear()
  await act(async () => {
    await result.current.surface?.setOption('effort', 'low')
  })
  expect(dispatchCommand).toHaveBeenCalledWith('/effort low')
  expect(settingsRpc).not.toHaveBeenCalled()
  for (let index = 0; index < 10; index++) {
    act(() => rerender({ dispatchCommand: vi.fn() }))
    expect(result.current.snapshot.find(({ id }) => id === 'effort')?.kind).toMatchObject({
      choices: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]
    })
    expect(terminalCatalog).toHaveBeenCalledTimes(1)
  }
  discoveryContext.mockReturnValueOnce({
    hostKey: 'other-host',
    runtime: { target: { kind: 'local' }, worktreeId: 'other-worktree', worktreePath: '/other' }
  })
  terminalCatalog.mockResolvedValue({ origin: 'unknown' })
  act(() => {
    result.current.surface?.demandModelCatalog?.()
  })
  await waitFor(() => expect(result.current.snapshot.some(({ id }) => id === 'effort')).toBe(false))
  expect(terminalCatalog).toHaveBeenCalledTimes(2)
  expect(terminalCatalog).toHaveBeenLastCalledWith(
    expect.objectContaining({ worktreeId: 'other-worktree', worktreePath: '/other' })
  )
  expect(modelDescriptor(result.current.snapshot).currentValue).toBe('gemini-3.8-flash-medium')
  unmount()
})

it('refreshes an open demand on context change and ignores a late answer from the previous context', async () => {
  const { createAntigravityTerminalModelDemand } =
    await import('./antigravity-terminal-model-observation')
  const old = Promise.withResolvers<unknown>()
  terminalCatalog
    .mockReset()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue({ origin: 'unknown' })
  discoveryContext.mockReturnValue({
    hostKey: 'old',
    runtime: { target: { kind: 'local' }, worktreeId: 'old-context', worktreePath: '/old' }
  })
  const demand = createAntigravityTerminalModelDemand('open-context')
  const publish = vi.fn()
  const stop = demand.demand(publish)
  expect(terminalCatalog).toHaveBeenCalledTimes(1)
  const resolvedBefore = discoveryContext.mock.calls.length
  for (const listener of storeListeners) {
    listener(storeState, storeState)
  }
  expect(discoveryContext.mock.calls).toHaveLength(resolvedBefore)
  discoveryContext.mockReturnValue({
    hostKey: 'new',
    runtime: { target: { kind: 'local' }, worktreeId: 'new-context', worktreePath: '/new' }
  })
  for (const listener of storeListeners) {
    listener({ ...storeState, settings: { terminalWindowsShell: 'wsl.exe' } }, storeState)
  }
  await waitFor(() => expect(terminalCatalog).toHaveBeenCalledTimes(2))
  await act(async () => {})
  old.resolve({
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'stale', label: 'Stale', efforts: [], isDefault: false }]
  })
  await act(async () => {})
  expect(publish).toHaveBeenLastCalledWith([])
  stop?.()
  expect(storeListeners.size).toBe(0)
  demand.dispose()
  discoveryContext.mockImplementation((terminalTabId: string) => ({
    hostKey: 'host',
    runtime: { target: { kind: 'local' }, worktreeId: terminalTabId, worktreePath: '/repo' }
  }))
})
