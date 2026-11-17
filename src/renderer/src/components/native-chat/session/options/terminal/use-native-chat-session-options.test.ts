// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../../../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'

import { clearNativeChatModelEnrichmentForTests } from '../catalog/native-chat-session-option-enrichment'

const discoverModels = vi.fn<() => Promise<readonly CatalogModel[] | null>>()

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../catalog/native-chat-session-option-discovery', () => ({
  resolveNativeChatModelDiscoveryContext: () => ({ hostKey: 'host', runtime: null }),
  discoverNativeChatCatalogModels: () => discoverModels()
}))

import { useNativeChatSessionOptions } from './use-native-chat-session-options'

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

function modelDescriptor(snapshot: { id: string; kind: unknown }[]): { currentValue?: string } {
  return snapshot.find((descriptor) => descriptor.id === 'model')?.kind as {
    currentValue?: string
  }
}

function pendingDiscovery(): (models: CatalogModel[]) => void {
  let resolveDiscovery: (models: CatalogModel[]) => void = () => {}
  discoverModels.mockReturnValue(
    new Promise<readonly CatalogModel[]>((resolve) => {
      resolveDiscovery = resolve
    })
  )
  return (models) => resolveDiscovery(models)
}

describe('useNativeChatSessionOptions Claude response model', () => {
  beforeEach(() => {
    clearNativeChatModelEnrichmentForTests()
    discoverModels.mockReset()
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  })

  it('names the model from the newest response once the frame is gone, without overriding a pick', async () => {
    discoverModels.mockResolvedValue(RESPONSE_MODELS)
    const dispatchCommand = vi.fn()
    const readTerminalScreen = (): string | null => null
    const { result, rerender } = renderHook(
      ({ response }: { response: { model: string; effort?: string } }) =>
        useNativeChatSessionOptions({
          agent: 'claude',
          terminalTabId: 'tab-response',
          targetPtyId: 'pty-response',
          dispatchCommand,
          readTerminalScreen,
          claudeResponse: response
        }),
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
    const resolveDiscovery = pendingDiscovery()
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
    const resolveDiscovery = pendingDiscovery()
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
      { initialProps: { agent: 'codex' as 'codex' | 'claude' } }
    )
    await Promise.resolve()

    rerender({ agent: 'claude' })
    resolveDiscovery([
      { id: 'opus', label: 'Opus', resolvedModel: 'claude-opus-5-5', options: [EFFORT] }
    ])

    await waitFor(() => expect(modelDescriptor(result.current.snapshot).currentValue).toBe('opus'))
  })
})
