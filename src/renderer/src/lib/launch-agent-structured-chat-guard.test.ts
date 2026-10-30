// @vitest-environment happy-dom

import {
  mockCreateTab,
  mockWaitForAgentReady,
  mockPasteDraftWhenAgentReady,
  mockCreateStructuredCodexSessionLaunchIntent,
  mockRetryStructuredAgentSessionLaunchIntent,
  mockLaunchStructuredCodexSession,
  mockRefreshLocalStructuredSessionTabs,
  mockToastError,
  mockCallStructuredAgentSession,
  mockCreateSupport,
  structuredLaunchIntent,
  liveStore,
  main
} from './launch-agent-structured-chat-test-fixture'
import type { AppState } from '@/store/types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import type { launchAgentInNewTab } from './launch-agent-in-new-tab'
import { makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { isPendingTab } from '@/runtime/layout-owner-pending-tabs'
import {
  resetStructuredAgentLaunchRegistryForTests,
  getStructuredLaunchStateBySessionId
} from './agent-session/launch/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './agent-session/launch/structured-agent-session-launch-persistence'
import * as capabilities from '@/runtime/local-runtime-capabilities'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const mockCreateUnifiedTab = vi.fn<AppState['createUnifiedTab']>()
const mockSetTabViewMode = vi.fn<AppState['setTabViewMode']>()
const mockMarkNativeChatLaunchPromptFailed = vi.fn<AppState['markNativeChatLaunchPromptFailed']>()
const STRUCTURED_HOST_CAPABILITIES = ['agent-session.structured.v1'] as const
let hostCapabilities: ReturnType<typeof capabilities.readLocalRuntimeCapabilitiesOrUnknown> =
  STRUCTURED_HOST_CAPABILITIES
const state = () => liveStore().getState()

function launchScenarioSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return createGlobalSettingsFixture({
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null,
    experimentalNativeChat: true,
    nativeChatSessionOptions: undefined,
    agentPermissionDefault: undefined,
    agentPermissionOverrides: undefined,
    ...overrides
  })
}

let warnings: MockInstance<typeof console.warn>
const owned: ReturnType<typeof launchAgentInNewTab>[] = []
const lateCreates: (() => void)[] = []
// No initial chat mode proves availability rejection preceded terminal-tab adoption.
describe('structured chat adoption guard on the launch path', () => {
  beforeEach(async () => {
    localStorage.clear()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    liveStore().setState({ settings: launchScenarioSettings() })
    mockCreateUnifiedTab.mockImplementation(state().createUnifiedTab)
    liveStore().setState({
      createUnifiedTab: mockCreateUnifiedTab,
      setTabViewMode: mockSetTabViewMode,
      markNativeChatLaunchPromptFailed: mockMarkNativeChatLaunchPromptFailed
    })
    vi.spyOn(capabilities, 'readLocalRuntimeCapabilitiesOrUnknown').mockImplementation(
      () => hostCapabilities
    )
    vi.spyOn(capabilities, 'ensureLocalRuntimeCapabilities').mockImplementation(
      async () => hostCapabilities
    )
    warnings = vi.spyOn(console, 'warn')
    mockWaitForAgentReady.mockResolvedValue({ ready: true, reason: 'foreground-match' })
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
    mockCreateStructuredCodexSessionLaunchIntent.mockImplementation((worktreeId: string) =>
      structuredLaunchIntent(worktreeId)
    )
    mockRetryStructuredAgentSessionLaunchIntent.mockImplementation((intent) => ({
      ...intent,
      params: {
        ...intent.params,
        envelope: {
          ...intent.params.envelope,
          clientOperationId: `${intent.params.envelope.clientOperationId}-retry`
        }
      }
    }))
    mockLaunchStructuredCodexSession.mockResolvedValue({
      sessionId: 'codex-session-1',
      fence: 1
    })
    mockCallStructuredAgentSession.mockResolvedValue({
      ok: true,
      page: { fence: 1 },
      value: { submission: { dispatchState: 'accepted' } }
    })
    mockRefreshLocalStructuredSessionTabs.mockResolvedValue([
      {
        worktree: 'wt-1',
        tabs: [{ type: 'agent-session', sessionId: 'codex-session-1' }]
      }
    ])
    mockCreateSupport.mockResolvedValue({ supported: true })
    hostCapabilities = STRUCTURED_HOST_CAPABILITIES
    const module = await import('./launch-agent-in-new-tab')
    const launch = module.launchAgentInNewTab
    vi.spyOn(module, 'launchAgentInNewTab').mockImplementation((args) => {
      const result = launch(args)
      owned.push(result)
      return result
    })
  })

  afterEach(async () => {
    const { cancelStructuredAgentLaunch, retireStructuredAgentSessionLaunchCancellationTombstone } =
      await import('./structured-agent-session-launch')
    const pending = ['codex-session-1', 'codex-session-2'].flatMap((id) => {
      const launch = getStructuredLaunchStateBySessionId(id)
      return launch ? [launch.promise] : []
    })
    for (const sessionId of ['codex-session-1', 'codex-session-2']) {
      cancelStructuredAgentLaunch('wt-1', sessionId)
    }
    for (const finish of lateCreates.splice(0)) {
      finish()
    }
    await Promise.allSettled(pending)
    await Promise.all(owned.splice(0).map((result) => result?.structuredSettlement))
    await main.settle()
    expect(lateCreates).toEqual([])
    expect(layoutApplyTestTransport.pendingCount).toBe(0)
    for (const tab of state().unifiedTabsByWorktree['wt-1'] ?? []) {
      expect(isPendingTab(tab.id)).toBe(false)
    }
    expect(
      warnings.mock.calls.filter(
        ([message]) => message === '[layout-owner] pending tab waiter threw:'
      )
    ).toEqual([])
    for (const id of ['codex-session-1', 'codex-session-2']) {
      retireStructuredAgentSessionLaunchCancellationTombstone('wt-1', id)
    }
  })

  it('takes the structured path when the chat-default view is selected', async () => {
    const { launchAgentInNewTab, shouldQueueTerminalFocusAfterMenuClose } =
      await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-1',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(result).toMatchObject({
      surface: { kind: 'host-published' },
      pasteDraftAfterLaunch: false
    })
    expect(mockCreateStructuredCodexSessionLaunchIntent).not.toHaveBeenCalled()
    expect(shouldQueueTerminalFocusAfterMenuClose(result!)).toBe(true)
    await expect(result?.structuredSettlement).resolves.toEqual({
      kind: 'structured',
      sessionId: 'codex-session-1'
    })
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledWith(
      'wt-1',
      'codex',
      'local',
      undefined,
      undefined,
      undefined
    )
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-1' }),
      expect.any(Function),
      false,
      expect.any(Function)
    )
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
  })

  it('takes the structured path when a Codex model and effort are already saved', async () => {
    liveStore().setState({
      settings: launchScenarioSettings({
        nativeChatSessionOptions: {
          codex: { model: 'gpt-5.6-sol', valuesByModel: { 'gpt-5.6-sol': { effort: 'medium' } } }
        }
      })
    })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-2',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(result).toMatchObject({ surface: { kind: 'host-published' } })
    await result?.structuredSettlement
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledWith(
      'wt-1',
      'codex',
      'local',
      undefined,
      undefined,
      undefined
    )
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('takes the structured path for Claude, naming Claude as the create provider', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-3',
      agent: 'claude',
      worktreeId: 'wt-1'
    })

    expect(result).toMatchObject({ surface: { kind: 'host-published' } })
    await result?.structuredSettlement
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledWith(
      'wt-1',
      'claude',
      'local',
      undefined,
      undefined,
      undefined
    )
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  // WSL-bound Claude accounts must decline before opening a chat that could only fail Retry.
  it('opens the terminal, and no chat, when this machine declines the chat', async () => {
    liveStore().setState({ unifiedTabsByWorktree: {} })
    mockCreateSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-declined',
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'start this task',
      promptDelivery: 'submit-after-ready'
    })

    expect(mockCreateTab).not.toHaveBeenCalled()
    await expect(result?.structuredSettlement).resolves.toEqual({ kind: 'terminal' })
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mockCreateTab).toHaveBeenCalledOnce()
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledOnce()
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'start this task' })
    )
    expect(mockCreateStructuredCodexSessionLaunchIntent).not.toHaveBeenCalled()
    expect(mockLaunchStructuredCodexSession).not.toHaveBeenCalled()
    expect(mockCreateUnifiedTab).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('keeps a native-chat agent with no structured adapter on the terminal-backed path', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ requestId: 'request-4', agent: 'openclaude', worktreeId: 'wt-1' })

    expect(mockCreateStructuredCodexSessionLaunchIntent).not.toHaveBeenCalled()
    expect(mockCreateTab).toHaveBeenCalled()
  })

  it.each([[], null])(
    'preserves terminal-backed launches with capability answer %s',
    async (capabilities) => {
      hostCapabilities = capabilities
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      const launches = [
        launchAgentInNewTab({ requestId: 'request-5', agent: 'claude', worktreeId: 'wt-1' }),
        launchAgentInNewTab({ requestId: 'request-6', agent: 'codex', worktreeId: 'wt-1' })
      ]
      // With no answer yet, each launch waits (bounded) for the runtime before opening its terminal.
      await Promise.all(launches.map((launch) => launch?.structuredSettlement))

      expect(mockCreateStructuredCodexSessionLaunchIntent).not.toHaveBeenCalled()
      expect(mockCreateTab).toHaveBeenCalledTimes(2)
    }
  )

  // Recheck persisted opt-in against current default view; the hidden toggle can remain enabled under Terminal chat.
  it('ignores a stale structured opt-in while the default view is Terminal chat', async () => {
    liveStore().setState({ settings: launchScenarioSettings({ experimentalNativeChat: false }) })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-7',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(result?.surface).toEqual({ kind: 'local-terminal', tabId: 'tab-1' })
    expect(mockLaunchStructuredCodexSession).not.toHaveBeenCalled()
    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'codex' })
    )
  })

  it('does not open a terminal on a definitive refusal', async () => {
    const { StructuredAgentSessionCreateRefusalError } =
      await import('./launch-structured-agent-session')
    const refusal = new StructuredAgentSessionCreateRefusalError('provider unavailable')
    mockLaunchStructuredCodexSession.mockRejectedValueOnce(refusal)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-8',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(result).toMatchObject({
      surface: { kind: 'host-published' },
      pasteDraftAfterLaunch: false
    })
    await expect(result?.structuredSettlement).resolves.toEqual({
      kind: 'failed',
      error: refusal
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(state().unifiedTabsByWorktree['wt-1']).toContainEqual(
      expect.objectContaining({ contentType: 'agent-session', entityId: 'codex-session-1' })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('reports no prompt delivery from a definitive refusal', async () => {
    const { StructuredAgentSessionCreateRefusalError } =
      await import('./launch-structured-agent-session')
    mockLaunchStructuredCodexSession.mockRejectedValueOnce(
      new StructuredAgentSessionCreateRefusalError('provider unavailable')
    )
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-9',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'start this task',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    await expect(result?.structuredSettlement).resolves.toMatchObject({
      kind: 'failed'
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockPasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('coalesces one action delivered twice for one worktree while the host is starting', async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    mockLaunchStructuredCodexSession.mockImplementationOnce(
      () =>
        new Promise<{ sessionId: string; fence: number }>((resolve) => {
          resolveLaunch = resolve
          lateCreates.push(() => resolve({ sessionId: 'codex-session-1', fence: 1 }))
        })
    )
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const first = launchAgentInNewTab({
      requestId: 'double-click',
      agent: 'codex',
      worktreeId: 'wt-1'
    })
    const second = launchAgentInNewTab({
      requestId: 'double-click',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(first).toMatchObject({ surface: { kind: 'host-published' } })
    expect(second).toMatchObject({ surface: { kind: 'host-published' } })
    await vi.waitFor(() => expect(mockLaunchStructuredCodexSession).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledTimes(1)
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledTimes(1)
    resolveLaunch({ sessionId: 'codex-session-1', fence: 1 })
    await Promise.all([first?.structuredSettlement, second?.structuredSettlement])
  })

  it('settles a successful create and opens its chat without an inventory refresh', async () => {
    liveStore().setState({ unifiedTabsByWorktree: {} })
    expect(state().getTab('structured-agent-session-codex-session-1')).toBeNull()
    mockRefreshLocalStructuredSessionTabs.mockRejectedValue(new Error('inventory unavailable'))
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'double-click',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    await expect(result?.structuredSettlement).resolves.toEqual({
      kind: 'structured',
      sessionId: 'codex-session-1'
    })
    expect(state().unifiedTabsByWorktree['wt-1']).toContainEqual(
      expect.objectContaining({ contentType: 'agent-session', entityId: 'codex-session-1' })
    )
    await main.settle()
    const tab = state().unifiedTabsByWorktree['wt-1']!.find(
      (row) => row.entityId === 'codex-session-1'
    )!
    expect(state().getTab(tab.id)).toBe(tab)
    expect(mockRefreshLocalStructuredSessionTabs).not.toHaveBeenCalled()
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('re-checks a chat whose visibility proof is unknown through its own Retry, with its own intent', async () => {
    liveStore().setState({ unifiedTabsByWorktree: {} })
    const firstIntent = structuredLaunchIntent('wt-1', 'codex-session-1')
    const secondIntent = structuredLaunchIntent('wt-1', 'codex-session-2')
    mockCreateStructuredCodexSessionLaunchIntent
      .mockReturnValueOnce(firstIntent)
      .mockReturnValueOnce(secondIntent)
    mockLaunchStructuredCodexSession
      .mockRejectedValueOnce(new Error('response lost'))
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ sessionId: secondIntent.sessionId, fence: 1 })
    mockRefreshLocalStructuredSessionTabs
      .mockRejectedValueOnce(new Error('inventory unavailable'))
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => {
        liveStore().setState({
          unifiedTabsByWorktree: {
            'wt-1': [
              makeUnifiedTab({
                id: `structured-agent-session-${firstIntent.sessionId}`,
                contentType: 'agent-session',
                entityId: firstIntent.sessionId,
                worktreeId: 'wt-1',
                groupId: 'group-1'
              })
            ]
          }
        })
        return Promise.resolve([
          { worktree: 'wt-1', tabs: [{ type: 'agent-session', sessionId: firstIntent.sessionId }] }
        ])
      })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const unknown = launchAgentInNewTab({
      requestId: 'request-14',
      agent: 'codex',
      worktreeId: 'wt-1'
    })
    await expect(unknown?.structuredSettlement).resolves.toEqual({
      kind: 'visibility-unknown',
      sessionId: firstIntent.sessionId
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockCreateUnifiedTab).toHaveBeenCalledWith(
      'wt-1',
      'agent-session',
      expect.objectContaining({ entityId: firstIntent.sessionId })
    )
    expect(mockToastError).not.toHaveBeenCalled()

    // A new launch would open a new chat; the unconfirmed one is re-checked by its own Retry.
    const { retryStructuredAgentSessionLaunch } = await import('./structured-agent-session-launch')
    expect(retryStructuredAgentSessionLaunch('wt-1', firstIntent.sessionId)).toBe(true)
    await vi.waitFor(() => expect(mockRefreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(3))

    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledTimes(1)
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledTimes(2)
    expect(mockLaunchStructuredCodexSession.mock.calls[0]?.[0]).toBe(firstIntent)
    expect(mockLaunchStructuredCodexSession.mock.calls[1]?.[0]).toBe(firstIntent)
    expect(mockLaunchStructuredCodexSession.mock.calls[0]?.[2]).toBe(false)
    expect(mockLaunchStructuredCodexSession.mock.calls[1]?.[2]).toBe(true)
    expect(mockRetryStructuredAgentSessionLaunchIntent).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockCallStructuredAgentSession).toHaveBeenCalledWith(
      firstIntent.target,
      'agentSession.history',
      expect.objectContaining({ sessionId: firstIntent.sessionId })
    )

    const next = launchAgentInNewTab({
      requestId: 'request-15',
      agent: 'codex',
      worktreeId: 'wt-1'
    })
    await expect(next?.structuredSettlement).resolves.toEqual({
      kind: 'structured',
      sessionId: secondIntent.sessionId
    })
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledTimes(2)
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledTimes(3)
    expect(mockLaunchStructuredCodexSession.mock.calls[2]?.[0]).toBe(secondIntent)
    expect(state().unifiedTabsByWorktree['wt-1']?.map((tab) => tab.entityId)).toEqual(
      expect.arrayContaining([firstIntent.sessionId, secondIntent.sessionId])
    )
    const replacement = state().unifiedTabsByWorktree['wt-1']!.find(
      (row) => row.entityId === secondIntent.sessionId
    )!
    liveStore().setState({ unifiedTabsByWorktree: { 'wt-1': [replacement] } })
    expect(state().getTab(`structured-agent-session-${firstIntent.sessionId}`)).toBeNull()
    expect(state().getTab(replacement.id)).toBe(replacement)
  })

  it('routes an auto-submitted Codex prompt through the structured outbox', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-16',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'start this task'
    })

    expect(result).toMatchObject({ surface: { kind: 'host-published' } })
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it("puts a refused structured prompt in the new chat's composer", async () => {
    mockCallStructuredAgentSession.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_busy', message: 'busy' }
    })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-17',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false,
      inComposer: true
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('keeps an SSH Codex tab on the bridge', async () => {
    liveStore().setState({ repos: [{ ...state().repos[0]!, connectionId: 'ssh-a' }] })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ requestId: 'request-18', agent: 'codex', worktreeId: 'wt-1' })

    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'codex' })
    )
    expect(mockCreateTab.mock.calls[0]?.[3]).not.toHaveProperty('viewMode')
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
  })

  it('keeps a runtime-paired Codex tab on the bridge', async () => {
    liveStore().setState({ repos: [{ ...state().repos[0]!, connectionId: 'runtime-ssh-a' }] })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ requestId: 'request-19', agent: 'codex', worktreeId: 'wt-1' })

    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'codex' })
    )
    expect(mockCreateTab.mock.calls[0]?.[3]).not.toHaveProperty('viewMode')
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
  })
})
