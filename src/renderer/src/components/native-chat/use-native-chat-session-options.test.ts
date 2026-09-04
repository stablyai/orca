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

vi.mock('../../store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ settings: {}, updateSettings: async () => undefined })
  })
}))

import { useNativeChatSessionOptions } from './use-native-chat-session-options'
import {
  clearNativeChatSessionOptionCacheForTests,
  seedNativeChatAppliedSessionOptions
} from './native-chat-session-option-cache'

// A 1M-context Opus session: the frame names the resolved model while the
// host's discovered catalog names the alias.
const CLAUDE_SCREEN =
  'Claude Code v2.1.220\r\nOpus 5 (1M context) with high effort · API Usage Billing\r\n~/repo'

// Codex `model-with-reasoning` + `task-progress` status line captured from the
// reporter's TUI (STA-4317): slug + effort + service tier, then a ` · ` item.
const CODEX_STATUS_LINE =
  '> Find and fix a bug in @filename\r\ngpt-5.6-luna max fast · ████████░░░░'

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

function effortValue(snapshot: { id: string; kind: unknown }[]): string | undefined {
  const effort = snapshot.find((descriptor) => descriptor.id === 'effort')
  return (effort?.kind as { currentValue?: string } | undefined)?.currentValue
}

describe('useNativeChatSessionOptions model reporting', () => {
  beforeEach(() => {
    clearNativeChatModelEnrichmentForTests()
    clearNativeChatSessionOptionCacheForTests()
    discoverModels.mockReset()
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
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

  it('keeps Codex UI and TUI on the same model for a plain session', async () => {
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'codex',
        terminalTabId: 'tab-codex-plain',
        targetPtyId: 'pty-codex-plain',
        dispatchCommand: vi.fn(),
        readTerminalScreen: () => CODEX_STATUS_LINE
      })
    )

    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('gpt-5.6-luna')
    )
    expect(effortValue(result.current.snapshot)).toBe('max')
  })

  it('follows a mid-session Codex model change reported by the agent hook', async () => {
    seedNativeChatAppliedSessionOptions('pty-codex-mid', 'codex', { model: 'gpt-5.6-terra' })
    const { result, rerender } = renderHook(
      ({ reportedModel }) =>
        useNativeChatSessionOptions({
          agent: 'codex',
          terminalTabId: 'tab-codex-mid',
          targetPtyId: 'pty-codex-mid',
          dispatchCommand: vi.fn(),
          reportedModel
        }),
      { initialProps: { reportedModel: 'gpt-5.6-terra' as string | null } }
    )

    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('gpt-5.6-terra')
    )

    rerender({ reportedModel: 'gpt-5.6-sol' })

    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('gpt-5.6-sol')
    )
  })

  it('shows the Codex TUI’s effective model after a provider fallback, not the launched one', async () => {
    seedNativeChatAppliedSessionOptions('pty-codex-fallback', 'codex', {
      model: 'gpt-5.6-terra',
      effort: 'ultra'
    })
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'codex',
        terminalTabId: 'tab-codex-fallback',
        targetPtyId: 'pty-codex-fallback',
        dispatchCommand: vi.fn(),
        readTerminalScreen: () => CODEX_STATUS_LINE
      })
    )

    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('gpt-5.6-luna')
    )
    expect(effortValue(result.current.snapshot)).toBe('max')
  })

  it('does not let a late hook model replace a TUI seed after the frame scrolls away', async () => {
    // Why: the first SessionStart slug is the launched id. Once the TUI has
    // named the effective model, a later render that can no longer parse the
    // frame must not treat that slug as a fresh report.
    seedNativeChatAppliedSessionOptions('pty-codex-scrolled', 'codex', {
      model: 'gpt-5.6-terra'
    })
    const { result, rerender } = renderHook(
      ({ reportedModel, frameVisible }) =>
        useNativeChatSessionOptions({
          agent: 'codex',
          terminalTabId: 'tab-codex-scrolled',
          targetPtyId: 'pty-codex-scrolled',
          dispatchCommand: vi.fn(),
          readTerminalScreen: () =>
            frameVisible ? CODEX_STATUS_LINE : 'conversation has scrolled past the frame',
          reportedModel
        }),
      { initialProps: { reportedModel: null as string | null, frameVisible: true } }
    )

    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('gpt-5.6-luna')
    )

    rerender({ reportedModel: 'gpt-5.6-terra', frameVisible: false })

    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('gpt-5.6-luna')
    )
  })

  it('treats a Codex catalog label and id as the same model', async () => {
    seedNativeChatAppliedSessionOptions('pty-codex-label', 'codex', { model: 'gpt-5.6-terra' })
    const { result } = renderHook(() =>
      useNativeChatSessionOptions({
        agent: 'codex',
        terminalTabId: 'tab-codex-label',
        targetPtyId: 'pty-codex-label',
        dispatchCommand: vi.fn(),
        reportedModel: 'GPT-5.6 Luna'
      })
    )

    await waitFor(() =>
      expect(modelDescriptor(result.current.snapshot).currentValue).toBe('gpt-5.6-luna')
    )
  })
})
