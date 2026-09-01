// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import { clearNativeChatModelEnrichmentForTests } from './native-chat-session-option-enrichment'

const discoverModels = vi.fn<() => Promise<readonly CatalogModel[] | null>>()

vi.mock('./native-chat-session-option-discovery', () => ({
  resolveNativeChatModelDiscoveryContext: () => ({ hostKey: 'host', runtime: null }),
  discoverNativeChatCatalogModels: () => discoverModels()
}))

const storeState = {
  settings: {},
  updateSettings: async () => undefined,
  agentStatusByPaneKey: {} as Record<string, { model?: string }>
}

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
}))

import { useNativeChatSessionOptions } from './use-native-chat-session-options'

// A 1M-context Opus session: the frame names the resolved model while the
// host's discovered catalog names the alias.
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

const OMP_DISCOVERED: CatalogModel[] = [
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', options: [] },
  { id: 'minimax-cn/MiniMax-M3', label: 'MiniMax M3', options: [] }
]

describe('useNativeChatSessionOptions model reporting', () => {
  beforeEach(() => {
    clearNativeChatModelEnrichmentForTests()
    discoverModels.mockReset()
    storeState.agentStatusByPaneKey = {}
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  })

  it('names an OMP session by the model its hook reports, before and after discovery', async () => {
    // Why: OMP seeds no models and has no terminal frame to read; the hook's
    // `provider/id` stamp is the only way the pill can name the running model.
    let resolveDiscovery: (models: CatalogModel[]) => void = () => {}
    discoverModels.mockReturnValue(
      new Promise<readonly CatalogModel[]>((resolve) => {
        resolveDiscovery = resolve
      })
    )
    const dispatchCommand = vi.fn()
    storeState.agentStatusByPaneKey['tab-omp:leaf'] = { model: 'deepseek/deepseek-v4-pro' }
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'omp',
        terminalTabId: 'tab-omp',
        targetPtyId: 'pty-omp',
        dispatchCommand,
        readTerminalScreen: () => null,
        paneKey: 'tab-omp:leaf'
      })
    )

    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('deepseek/deepseek-v4-pro')
    )
    // Nothing discovered yet: the reported selector is the only row.
    expect(modelDescriptor(result.current.snapshot).choices.map((choice) => choice.value)).toEqual([
      'deepseek/deepseek-v4-pro'
    ])

    resolveDiscovery(OMP_DISCOVERED)
    await waitFor(() =>
      expect(
        modelDescriptor(result.current.snapshot).choices.map((choice) => choice.value)
      ).toEqual(['deepseek/deepseek-v4-pro', 'minimax-cn/MiniMax-M3'])
    )
    expect(modelDescriptor(result.current.snapshot).currentValue).toBe('deepseek/deepseek-v4-pro')
  })

  it('lets a pick stand until the OMP hook reports a different model', async () => {
    discoverModels.mockResolvedValue(OMP_DISCOVERED)
    const dispatchCommand = vi.fn(async () => 'accepted' as const)
    const readTerminalScreen = (): string | null => null
    const paneKey = 'tab-omp-pick:leaf'
    storeState.agentStatusByPaneKey[paneKey] = { model: 'deepseek/deepseek-v4-pro' }
    const { result, rerender } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'omp',
        terminalTabId: 'tab-omp-pick',
        targetPtyId: 'pty-omp-pick',
        dispatchCommand,
        readTerminalScreen,
        paneKey
      })
    )
    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('deepseek/deepseek-v4-pro')
    )

    await result.current.surface!.setOption('model', 'minimax-cn/MiniMax-M3')
    expect(dispatchCommand).toHaveBeenCalledWith('/model minimax-cn/MiniMax-M3')
    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('minimax-cn/MiniMax-M3')
    )

    // The same report re-delivered on the next status ping is not new evidence.
    storeState.agentStatusByPaneKey[paneKey] = { model: 'deepseek/deepseek-v4-pro' }
    rerender()
    await Promise.resolve()
    expect(modelDescriptor(result.current.snapshot).currentValue).toBe('minimax-cn/MiniMax-M3')

    // A changed report is: the hook confirms the switch.
    storeState.agentStatusByPaneKey[paneKey] = { model: 'minimax-cn/MiniMax-M3' }
    rerender()
    await waitFor(() =>
      expect(
        result.current.snapshot.find((descriptor) => descriptor.id === 'model')?.valueSource
      ).toBe('reported')
    )
  })

  it('ignores a hook-reported model for Claude, whose frame is authoritative', async () => {
    discoverModels.mockResolvedValue(DISCOVERED)
    storeState.agentStatusByPaneKey['tab-claude-hook:leaf'] = { model: 'haiku' }
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'tab-claude-hook',
        targetPtyId: 'pty-claude-hook',
        dispatchCommand: vi.fn(),
        readTerminalScreen: () => null,
        paneKey: 'tab-claude-hook:leaf'
      })
    )
    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).choices.length).toBeGreaterThan(0)
    )
    expect(modelDescriptor(result.current.snapshot).currentValue).toBeUndefined()
  })

  it('re-resolves the reported model against models discovered after the read', async () => {
    // Why: discovery is async, so the first scrape can only reach the seed. If
    // the reported id were left at the family the picker would show a row it
    // had to invent — and by then the frame may have scrolled out of the buffer,
    // so re-reading the screen is not an option.
    let resolveDiscovery: (models: CatalogModel[]) => void = () => {}
    discoverModels.mockReturnValue(
      new Promise<readonly CatalogModel[]>((resolve) => {
        resolveDiscovery = resolve
      })
    )

    // Stable identity, and the frame scrolls out of the buffer before discovery
    // lands — so nothing but the cached screen can drive the re-resolution.
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
    // The invented family row is gone: every choice is one the host listed.
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

  it('clears a previously reported screen when the target pty changes', async () => {
    let resolveDiscovery: (models: CatalogModel[]) => void = () => {}
    discoverModels.mockReturnValue(
      new Promise<readonly CatalogModel[]>((resolve) => {
        resolveDiscovery = resolve
      })
    )
    const getMainBufferSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ data: CLAUDE_SCREEN, alternateScreen: false })
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
          terminalTabId: 'tab-reset',
          targetPtyId,
          dispatchCommand,
          readTerminalScreen: () => null
        }),
      { initialProps: { targetPtyId: 'pty-reported' } }
    )
    await waitFor(() => expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus'))

    rerender({ targetPtyId: 'pty-empty' })
    resolveDiscovery(DISCOVERED)

    await waitFor(() =>
      expect(
        modelDescriptor(result.current.snapshot).choices.map((choice) => choice.value)
      ).toEqual(['opus[1m]', 'haiku'])
    )
    expect(modelDescriptor(result.current.snapshot).currentValue).toBeUndefined()
  })
})
