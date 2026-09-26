// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type * as LaunchIntentModule from '@/lib/launch-structured-agent-session'

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params?: unknown) => Promise<unknown>>(),
  launch: vi.fn<(intent: { sessionId: string }) => Promise<{ sessionId: string; fence: number }>>(),
  toastError: vi.fn()
}))

let readState: StructuredAgentSessionState
let publishedTabs: unknown[] = []

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('@/lib/launch-structured-agent-session', async () => {
  const actual = await vi.importActual<typeof LaunchIntentModule>(
    '@/lib/launch-structured-agent-session'
  )
  return { ...actual, launchStructuredAgentSession: mocks.launch }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: () => Promise.resolve(publishedTabs)
}))

vi.mock('./use-structured-agent-session-hold', () => ({
  useStructuredAgentSessionHold: () => undefined
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: readState,
    loadingOlder: false,
    loadOlder: vi.fn<() => Promise<void>>()
  })
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn<(target: unknown, mutation: unknown) => Promise<void>>()
}))

import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { startStructuredAgentLaunch } from '@/lib/structured-agent-session-launch'
import { resetStructuredAgentLaunchPersistenceForTests } from '@/lib/structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/structured-agent-session-launch-registry'
import { useNativeChatProvisionalLaunch } from './use-native-chat-provisional-launch'
import { useStructuredAgentSession } from './use-structured-agent-session'

const LOCAL_TARGET = { kind: 'local' } as const

function saveSelection(model: string): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp/orca-workspaces'),
      nativeChatSessionOptions: { codex: { model } }
    }
  })
}

function sessionState(fence: number | null): StructuredAgentSessionState {
  return {
    epoch: 'epoch-1',
    cursor: null,
    fence,
    items: [],
    submissions: [],
    retainedItemLimit: 1_024,
    hasOlder: false,
    status: 'ready',
    commands: []
  }
}

function publishedSnapshot(worktreeId: string, sessionId: string) {
  return {
    worktree: worktreeId,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [{ type: 'agent-session', id: 'tab-1', title: 'Codex', sessionId, agent: 'codex' }]
  }
}

/** The pane's wiring: the launch's view feeds the chat controller. */
function renderLaunchedChat(worktreeId: string, sessionId: string) {
  return renderHook(() => {
    const provisional = useNativeChatProvisionalLaunch(worktreeId, sessionId)
    return useStructuredAgentSession({
      sessionId,
      target: LOCAL_TARGET,
      agent: 'codex',
      isVisible: true,
      transportEnabled: provisional.transportEnabled,
      ...(provisional.launch ? { launch: provisional.launch } : {})
    })
  })
}

function currentModel(snapshot: readonly { id: string; kind: { type: string } }[]) {
  const model = snapshot.find((entry) => entry.id === 'model')?.kind
  return model && 'currentValue' in model ? model.currentValue : undefined
}

describe('a chat pane over its own launch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    readState = sessionState(null)
    publishedTabs = []
    mocks.launch.mockReturnValue(new Promise(() => {}))
    mocks.call.mockImplementation(() => new Promise(() => {}))
  })

  it('keeps the selection its create seeded when a pick in another chat saves a new one', () => {
    saveSelection('gpt-5.5')
    startStructuredAgentLaunch('wt-first', 'codex')
    const second = startStructuredAgentLaunch('wt-second', 'codex')
    const { result, rerender } = renderLaunchedChat('wt-second', second.sessionId)
    expect(currentModel(result.current.optionSnapshot)).toBe('gpt-5.5')

    // The first chat's pick lands in settings while the second is still launching.
    act(() => saveSelection('gpt-5.6-luna'))
    rerender()
    expect(currentModel(result.current.optionSnapshot)).toBe('gpt-5.5')
    // The catalog read names where this chat runs, so the host can check that workspace's config.
    expect(mocks.call).toHaveBeenCalledWith(
      LOCAL_TARGET,
      'agentSession.modelCatalog',
      expect.objectContaining({ worktree: 'id:wt-second' })
    )
  })

  it('shows a pick the launch could not apply the way a refused option change is shown', async () => {
    saveSelection('gpt-5.5')
    let created!: (receipt: { sessionId: string; fence: number }) => void
    mocks.launch.mockReturnValue(new Promise((resolve) => (created = resolve)))
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.setOption'
        ? Promise.resolve({
            ok: false,
            refusal: { code: 'invalid_option', message: 'GPT-5.6 Luna is not available' }
          })
        : new Promise(() => {})
    )
    const launch = startStructuredAgentLaunch('wt-refused', 'codex')
    const { sessionId } = launch
    const { result, rerender } = renderLaunchedChat('wt-refused', sessionId)
    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-5.6-luna')).toBe(true)
    })
    expect(currentModel(result.current.optionSnapshot)).toBe('gpt-5.6-luna')

    publishedTabs = [publishedSnapshot('wt-refused', sessionId)]
    readState = sessionState(1)
    await act(async () => {
      created({ sessionId, fence: 1 })
      await launch.launchResult
    })
    rerender()
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("The setting wasn't changed. Choose it again.")
    )
    // Reverted to what the chat runs; the refusal never kept the launch from publishing.
    expect(currentModel(result.current.optionSnapshot)).toBe('gpt-5.5')
  })
})
