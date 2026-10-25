// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type * as LaunchIntentModule from '@/lib/launch-structured-agent-session'

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params?: unknown) => Promise<unknown>>(),
  launch:
    vi.fn<
      (
        intent: { sessionId: string },
        onSeed?: LaunchIntentModule.StructuredLaunchHostSeedListener
      ) => Promise<{ sessionId: string; fence: number }>
    >(),
  toastError: vi.fn()
}))

let readState: StructuredAgentSessionState
let publishedTabs: unknown[] = []

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('@/lib/structured-agent-session-launch-create-call', () => ({
  launchStructuredAgentSession: mocks.launch
}))

vi.mock('@/lib/launch-structured-agent-session', async () => {
  const actual = await vi.importActual<typeof LaunchIntentModule>(
    '@/lib/launch-structured-agent-session'
  )
  return { ...actual, launchStructuredAgentSession: mocks.launch }
})

vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: () => Promise.resolve(publishedTabs)
}))
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: () => Promise.resolve(publishedTabs)
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
import {
  startStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch
} from '@/lib/structured-agent-session-launch'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import { resetStructuredAgentLaunchPersistenceForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { useNativeChatProvisionalLaunch } from './use-native-chat-provisional-launch'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { getStructuredAgentSessionLaunchSelection } from '@/lib/structured-agent-session-launch-options'
import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'

const LOCAL_TARGET = { kind: 'local' } as const
const SAVED_LIST = {
  origin: 'probe',
  models: [
    { id: 'gpt-5.5', label: 'GPT-5.5', efforts: [] },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: [] }
  ],
  fetchedAt: 1_000
}

function answerCatalog(method: string): Promise<unknown> {
  return method === 'agentSession.modelCatalog'
    ? Promise.resolve(SAVED_LIST)
    : new Promise(() => {})
}

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
    retainedOwnItemLimit: 1_024,
    retainedItemCap: 8_192,
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

function renderLaunchedChat(
  worktreeId: string,
  sessionId: string,
  agent: 'codex' | 'claude' = 'codex',
  target: RuntimeClientTarget = LOCAL_TARGET
) {
  return renderHook((selectedSessionId: string = sessionId) => {
    const provisional = useNativeChatProvisionalLaunch(worktreeId, selectedSessionId)
    const chat = useStructuredAgentSession({
      sessionId: selectedSessionId,
      target,
      agent,
      providerStarting: true,
      isVisible: true,
      transportEnabled: provisional.transportEnabled,
      ...(provisional.launch ? { launch: provisional.launch } : {})
    })
    return { ...chat, launchView: provisional.launch }
  })
}

function currentModel(snapshot: readonly { id: string; kind: { type: string } }[]) {
  const model = snapshot.find((entry) => entry.id === 'model')?.kind
  return model && 'currentValue' in model ? model.currentValue : undefined
}

describe('a chat pane over its own launch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionSendsForTests()
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY])
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    readState = sessionState(null)
    publishedTabs = []
    mocks.launch.mockReturnValue(new Promise(() => {}))
    mocks.call.mockImplementation((_target, method) => answerCatalog(method))
    resetHostModelCatalogSnapshotsForTests()
  })

  afterEach(() => resetStructuredAgentSessionSendsForTests())

  it.each([undefined, { model: 'gpt-5.5' }])(
    'holds paired picks through reload and Retry until the host answers (%s)',
    async (seed) => {
      mocks.call.mockImplementation((_target, method) =>
        method === 'agentSession.modelCatalog'
          ? Promise.resolve({
              ...SAVED_LIST,
              listingNamesConfiguredModel: true,
              models: SAVED_LIST.models.map((model) => ({
                ...model,
                isDefault: model.id === 'gpt-5.5',
                efforts: [
                  { value: 'low', label: 'Low' },
                  { value: 'high', label: 'High' }
                ]
              }))
            })
          : new Promise(() => {})
      )
      const worktreeId = 'paired-pending'
      const target = { kind: 'environment', environmentId: 'server-1' } as const
      const launch = startStructuredAgentLaunch(worktreeId, 'codex', {
        requestId: 'paired-reload',
        executionHostId: 'runtime:server-1'
      })
      const fresh = renderLaunchedChat(worktreeId, launch.sessionId, 'codex', target)
      expect(fresh.result.current.launchView?.seedPending).toBe(true)
      fresh.unmount()
      resetStructuredAgentLaunchRegistryForTests()
      resetStructuredAgentLaunchPersistenceForTests()
      const restored = renderLaunchedChat(worktreeId, launch.sessionId, 'codex', target)
      const command = (text: string) =>
        dispatchStructuredAgentSessionComposerCommand(text, {
          snapshot: restored.result.current.optionSnapshot,
          invokeAction: async () => false,
          setOption: restored.result.current.setStructuredOption
        })
      await waitFor(() =>
        expect(
          restored.result.current.optionSnapshot.find((entry) => entry.id === 'model')
        ).toMatchObject({
          settable: false,
          kind: { choices: expect.arrayContaining([expect.objectContaining({ value: 'gpt-5.5' })]) }
        })
      )
      await expect(command('/model gpt-5.5')).resolves.toMatchObject({ accepted: false })
      act(() => {
        retryStructuredAgentSessionLaunch(worktreeId, launch.sessionId)
      })
      await waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(2))
      await expect(command('/effort high')).resolves.toMatchObject({ accepted: false })
      act(() => {
        mocks.launch.mock.lastCall?.[1]?.(seed)
      })
      expect(
        restored.result.current.optionSnapshot.find((entry) => entry.id === 'model')?.settable
      ).toBe(true)
      await act(async () => {
        await expect(command('/model gpt-5.5')).resolves.toMatchObject({ accepted: true })
        await expect(command('/effort high')).resolves.toMatchObject({ accepted: true })
      })
    }
  )

  it.each([false, true])(
    'keeps launch intent after retirement and on first send (accepted picks: %s)',
    async (picked) => {
      useAppStore.setState({
        settings: {
          ...getDefaultSettings('/tmp/orca-workspaces'),
          nativeChatSessionOptions: {
            claude: { model: 'sonnet', valuesByModel: { sonnet: { effort: 'low' } } }
          }
        }
      })
      const catalog = {
        origin: 'probe',
        fetchedAt: 1,
        models: ['sonnet', 'opus'].map((id) => ({
          id,
          label: id,
          isDefault: id === 'opus',
          defaultEffort: 'high',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }))
      }
      mocks.call.mockImplementation((_target, method) => {
        if (method === 'agentSession.modelCatalog') {
          return Promise.resolve(catalog)
        }
        if (method === 'agentSession.setOption') {
          return Promise.resolve({ ok: true, value: { options: { model: 'opus', effort: 'low' } } })
        }
        return new Promise(() => {})
      })
      let created!: (receipt: { sessionId: string; fence: number }) => void
      mocks.launch.mockReturnValue(new Promise((resolve) => (created = resolve)))
      const launch = startStructuredAgentLaunch('wt-claude', 'claude', { requestId: 'request-4' })
      const view = renderLaunchedChat('wt-claude', launch.sessionId, 'claude')
      await waitFor(() => expect(currentModel(view.result.current.optionSnapshot)).toBe('sonnet'))
      if (picked) {
        await act(async () => {
          expect(await view.result.current.setStructuredOption('model', 'opus')).toBe(true)
          expect(await view.result.current.setStructuredOption('effort', 'low')).toBe(true)
        })
      }
      publishedTabs = [publishedSnapshot('wt-claude', launch.sessionId)]
      readState = sessionState(1)
      await act(async () => {
        created({ sessionId: launch.sessionId, fence: 1 })
        await launch.launchResult
      })
      view.rerender()
      await waitFor(() =>
        expect(getStructuredAgentSessionLaunchSelection(launch.sessionId)).toBeNull()
      )
      const expected = { model: picked ? 'opus' : 'sonnet', effort: 'low' }
      expect(currentModel(view.result.current.optionSnapshot)).toBe(expected.model)
      const effort = view.result.current.optionSnapshot.find((entry) => entry.id === 'effort')?.kind
      expect(effort?.type === 'select' && effort.currentValue).toBe('low')
      act(() => {
        expect(view.result.current.send('first message')).toBe(true)
      })
      await waitFor(() =>
        expect(mocks.call).toHaveBeenCalledWith(
          LOCAL_TARGET,
          'agentSession.send',
          expect.objectContaining({ options: expected })
        )
      )
      await act(async () => {
        await view.result.current.setStructuredOption('model', 'sonnet')
      })
      expect(currentModel(view.result.current.optionSnapshot)).toBe('opus')
      view.rerender('unrelated-chat')
      expect(view.result.current.launchView).toBeUndefined()
    }
  )

  it('keeps the selection its create seeded when a pick in another chat saves a new one', async () => {
    saveSelection('gpt-5.5')
    startStructuredAgentLaunch('wt-first', 'codex', { requestId: 'request-1' })
    const second = startStructuredAgentLaunch('wt-second', 'codex', { requestId: 'request-2' })
    const { result, rerender } = renderLaunchedChat('wt-second', second.sessionId)
    await waitFor(() => expect(currentModel(result.current.optionSnapshot)).toBe('gpt-5.5'))

    act(() => saveSelection('gpt-5.6-luna'))
    rerender()
    expect(currentModel(result.current.optionSnapshot)).toBe('gpt-5.5')
    // Catalog reads must include this workspace so the host can apply its config.
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
        : answerCatalog(method)
    )
    const launch = startStructuredAgentLaunch('wt-refused', 'codex', { requestId: 'request-3' })
    const { sessionId } = launch
    const { result, rerender } = renderLaunchedChat('wt-refused', sessionId)
    await waitFor(() => expect(currentModel(result.current.optionSnapshot)).toBe('gpt-5.5'))
    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-5.6-luna')).toBe(true)
    })
    expect(currentModel(result.current.optionSnapshot)).toBe('gpt-5.6-luna')

    publishedTabs = [publishedSnapshot('wt-refused', sessionId)]
    readState = sessionState(1)
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve({ models: SAVED_LIST.models, current: { model: 'gpt-5.5' } })
        : method === 'agentSession.setOption'
          ? Promise.resolve({
              ok: false,
              refusal: { code: 'invalid_option', message: 'GPT-5.6 Luna is not available' }
            })
          : answerCatalog(method)
    )
    await act(async () => {
      created({ sessionId, fence: 1 })
      await launch.launchResult
    })
    rerender()
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("The setting wasn't changed.")
    )
    await waitFor(() => expect(currentModel(result.current.optionSnapshot)).toBe('gpt-5.5'))
  })
})
