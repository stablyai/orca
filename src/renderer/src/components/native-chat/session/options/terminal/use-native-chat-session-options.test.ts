// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../../../../shared/agent-session/options/agent-session-option-catalog-types'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'

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

const TRANSCRIPT_RESPONSE: NativeChatMessage = {
  id: 'response',
  role: 'assistant',
  source: 'transcript',
  timestamp: null,
  blocks: [{ type: 'text', text: 'Finished the change.' }],
  model: 'claude-opus-5-5'
}

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

  it('uses the last real root transcript model only as an unknown selection display fallback', async () => {
    discoverModels.mockResolvedValue(DISCOVERED)
    const dispatchCommand = vi.fn().mockResolvedValue({ outcome: 'applied' })
    const history: NativeChatMessage[] = [
      TRANSCRIPT_RESPONSE,
      { ...TRANSCRIPT_RESPONSE, id: 'synthetic', model: '<synthetic>' },
      { ...TRANSCRIPT_RESPONSE, id: 'child', agentId: 'worker', model: 'child-model' },
      { ...TRANSCRIPT_RESPONSE, id: 'user', role: 'user', model: 'user-model' },
      { ...TRANSCRIPT_RESPONSE, id: 'preview', source: 'hook', model: 'preview-model' },
      { ...TRANSCRIPT_RESPONSE, id: 'launch', agentStart: true, model: 'launch-model' },
      { ...TRANSCRIPT_RESPONSE, id: 'empty', model: '  ' }
    ]
    const { result, rerender } = renderHook(
      ({ transcriptMessages }) =>
        useNativeChatSessionOptions({
          agent: 'claude',
          terminalTabId: 'transcript-fallback-tab',
          targetPtyId: 'transcript-fallback-pty',
          dispatchCommand,
          transcriptMessages
        }),
      { initialProps: { transcriptMessages: history } }
    )

    await waitFor(() =>
      expect(result.current.snapshot.find(({ id }) => id === 'model')).toMatchObject({
        valueSource: 'unknown',
        reportedModel: 'claude-opus-5-5'
      })
    )
    expect(modelDescriptor(result.current.snapshot).currentValue).toBeUndefined()
    expect(
      result.current.surface?.getSnapshot().find(({ id }) => id === 'model')?.reportedModel
    ).toBeUndefined()

    rerender({
      transcriptMessages: [
        ...history,
        { ...TRANSCRIPT_RESPONSE, id: 'new-response', model: 'claude-sonnet-5-5' }
      ]
    })
    expect(result.current.snapshot.find(({ id }) => id === 'model')?.reportedModel).toBe(
      'claude-sonnet-5-5'
    )

    await act(async () => {
      await result.current.surface?.setOption('model', 'haiku')
    })
    rerender({
      transcriptMessages: [...history, { ...TRANSCRIPT_RESPONSE, id: 'late-old-response' }]
    })
    expect(modelDescriptor(result.current.snapshot).currentValue).toBe('haiku')
    expect(result.current.snapshot.find(({ id }) => id === 'model')?.reportedModel).toBeUndefined()
  })

  it('retires a conversation fallback when the pane moves to an empty transcript', async () => {
    discoverModels.mockResolvedValue(DISCOVERED)
    const dispatchCommand = vi.fn()
    const { result, rerender } = renderHook(
      ({ targetPtyId, transcriptMessages }) =>
        useNativeChatSessionOptions({
          agent: 'claude',
          terminalTabId: 'transcript-reset-tab',
          targetPtyId,
          dispatchCommand,
          transcriptMessages
        }),
      {
        initialProps: {
          targetPtyId: 'transcript-old-pty',
          transcriptMessages: [TRANSCRIPT_RESPONSE]
        }
      }
    )
    await waitFor(() =>
      expect(result.current.snapshot.find(({ id }) => id === 'model')?.reportedModel).toBe(
        'claude-opus-5-5'
      )
    )

    rerender({ targetPtyId: 'transcript-new-pty', transcriptMessages: [] })
    expect(result.current.snapshot.find(({ id }) => id === 'model')?.reportedModel).toBeUndefined()
    expect(modelDescriptor(result.current.snapshot).currentValue).toBeUndefined()
  })

  it('does not replace a terminal-reported selection with an older response model', async () => {
    discoverModels.mockResolvedValue(DISCOVERED)
    const dispatchCommand = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'claude',
        terminalTabId: 'transcript-banner-tab',
        targetPtyId: 'transcript-banner-pty',
        dispatchCommand,
        readTerminalScreen: () => CLAUDE_SCREEN,
        transcriptMessages: [{ ...TRANSCRIPT_RESPONSE, model: 'claude-haiku-5-5' }]
      })
    )

    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus[1m]')
    )
    expect(result.current.snapshot.find(({ id }) => id === 'model')?.reportedModel).toBeUndefined()
  })

  it('leaves other terminal agents unchanged when transcript metadata is present', async () => {
    discoverModels.mockResolvedValue(null)
    const dispatchCommand = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'codex',
        terminalTabId: 'transcript-codex-tab',
        targetPtyId: 'transcript-codex-pty',
        dispatchCommand,
        transcriptMessages: [TRANSCRIPT_RESPONSE]
      })
    )
    await waitFor(() => expect(result.current.snapshot.length).toBeGreaterThan(0))
    expect(result.current.snapshot.find(({ id }) => id === 'model')?.reportedModel).toBeUndefined()
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
