// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../../../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'

import { clearNativeChatModelEnrichmentForTests } from '../catalog/native-chat-session-option-enrichment'

const discoverModels = vi.fn<() => Promise<readonly CatalogModel[] | null>>()
const settingsRpc = vi.fn()

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (...args: unknown[]) => settingsRpc(...args)
}))

vi.mock('../catalog/native-chat-session-option-discovery', () => ({
  resolveNativeChatModelDiscoveryContext: () => ({ hostKey: 'host', runtime: null }),
  discoverNativeChatCatalogModels: () => discoverModels()
}))

const storeState: {
  settings: Record<string, unknown>
  updateSettings: () => Promise<undefined>
  agentStatusByPaneKey: Record<string, { model?: string; modelSwitchCommand?: 'orca-model' }>
} = {
  settings: {},
  updateSettings: async () => undefined,
  agentStatusByPaneKey: {}
}

vi.mock('../../../../../store/index', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
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

const EFFORT = {
  id: 'effort',
  label: 'Effort',
  kind: {
    type: 'select' as const,
    defaultValue: 'high',
    choices: ['low', 'high'].map((value) => ({ value, label: value }))
  },
  apply: {}
}

const RESPONSE_MODELS: CatalogModel[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', options: [EFFORT] },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', options: [EFFORT] }
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

  it('names the model from the newest response once the frame is gone, without overriding a pick', async () => {
    discoverModels.mockResolvedValue(RESPONSE_MODELS)
    const dispatchCommand = vi.fn()
    const readTerminalScreen = (): string | null => null
    const options = (claudeResponse: { model: string; effort?: string }) => ({
      agent: 'claude' as const,
      terminalTabId: 'tab-response',
      targetPtyId: 'pty-response',
      dispatchCommand,
      readTerminalScreen,
      claudeResponse
    })

    const { result, rerender } = renderHook(
      ({ response }) => useNativeChatSessionOptions(options(response)),
      { initialProps: { response: { model: 'claude-opus-5-5', effort: 'high' } } }
    )
    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('claude-opus-5-5')
    )

    result.current.surface!.recordOutgoingCommand('/model claude-sonnet-5-5')
    rerender({ response: { model: 'claude-opus-5-5', effort: 'low' } })
    await Promise.resolve()
    expect(modelDescriptor(result.current.snapshot).currentValue).toBe('claude-sonnet-5-5')
  })

  it('names a response model by the listed alias that discovery reports later', async () => {
    let resolveDiscovery: (models: CatalogModel[]) => void = () => {}
    discoverModels.mockReturnValue(
      new Promise<readonly CatalogModel[]>((resolve) => {
        resolveDiscovery = resolve
      })
    )
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'tab-alias',
        targetPtyId: 'pty-alias',
        dispatchCommand: vi.fn(),
        readTerminalScreen: () => null,
        claudeResponse: { model: 'claude-opus-5-5', effort: 'low' }
      })
    )

    resolveDiscovery([
      { id: 'opus', label: 'Opus', resolvedModel: 'claude-opus-5-5', options: [EFFORT] },
      { id: 'haiku', label: 'Haiku', options: [] }
    ])

    await waitFor(() => expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus'))
    const effort = result.current.snapshot.find((descriptor) => descriptor.id === 'effort')
    expect(effort?.kind).toMatchObject({ currentValue: 'low' })
  })

  it('names a response model from the seed catalog when discovery lists nothing', async () => {
    discoverModels.mockResolvedValue(null)
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'tab-unlisted',
        targetPtyId: 'pty-unlisted',
        dispatchCommand: vi.fn(),
        readTerminalScreen: () => null,
        claudeResponse: { model: 'claude-opus-5-5', effort: 'high' }
      })
    )

    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('claude-opus-5-5')
    )
  })

  it('waits for Claude discovery after a Codex session on the same host listed nothing', async () => {
    let resolveDiscovery: (models: CatalogModel[]) => void = () => {}
    discoverModels.mockReturnValue(
      new Promise<readonly CatalogModel[]>((resolve) => {
        resolveDiscovery = resolve
      })
    )
    const { result, rerender } = renderHook(
      ({ agent }: { agent: 'codex' | 'claude' }) =>
        useNativeChatSessionOptions({
          agent,
          terminalTabId: 'tab-switch',
          targetPtyId: 'pty-switch',
          dispatchCommand: vi.fn(),
          readTerminalScreen: () => null,
          claudeResponse: { model: 'claude-opus-5-5', effort: 'low' }
        }),
      { initialProps: { agent: 'codex' } }
    )
    await Promise.resolve()

    rerender({ agent: 'claude' })
    resolveDiscovery([
      { id: 'opus', label: 'Opus', resolvedModel: 'claude-opus-5-5', options: [EFFORT] }
    ])

    await waitFor(() => expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus'))
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
