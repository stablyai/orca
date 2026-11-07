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
  liveStore,
  main
} from './launch-agent-structured-chat-test-fixture'
import { structuredLaunchIntent } from './structured-session-launch-intent.test-fixture'
import type { AppState } from '@/store/types'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { createGlobalSettingsFixture } from '../../../../../../shared/global-settings-test-fixture'
import type { launchAgentInNewTab } from './launch-agent-in-new-tab'
import '@/store/testing/app-store-test-fixture'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { isPendingTab } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import {
  resetStructuredAgentLaunchRegistryForTests,
  getStructuredLaunchStateBySessionId,
  retireStructuredAgentSessionLaunchCancellationTombstone
} from '../structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from '../structured-agent-session-launch-persistence'
import * as capabilities from '@/runtime/hosts/capabilities/local-runtime-capabilities'
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
    agentDefaultSurface: 'chat',
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
    const { cancelStructuredAgentLaunch } = await import('../structured-agent-session-launch')
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
    const { retryStructuredAgentSessionLaunch } = await import('../structured-agent-session-launch')
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
})
