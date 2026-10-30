// @vitest-environment happy-dom

import {
  mockCreateTab,
  mockCreateUnifiedTab,
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
  store,
  structuredLaunchErrorMocks,
  setHostCapabilities
} from './launch-agent-structured-chat-test-fixture'
import type * as PickerMenu from '@/components/agent/AgentLaunchPickerMenu'
import type * as Dropdown from '@/components/ui/dropdown-menu'
import type * as Tooltip from '@/components/ui/tooltip'
import type * as QuickLaunch from '@/components/tab-bar/QuickLaunchButton'
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { buildNewTabAgentMenuRows } from '../../../shared/agent-launch-picker-rows'
import type * as StructuredLaunch from './launch-structured-agent-session'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const launchErrorMocks = structuredLaunchErrorMocks()

// No initial chat mode proves availability rejection preceded terminal-tab adoption.
describe('structured chat adoption guard on the launch path', () => {
  let restoreCatalogStore: (() => void) | undefined
  beforeEach(async () => {
    const { registerStructuredSelectionCatalogStore } =
      await import('./structured-agent-session-selection-controller')
    restoreCatalogStore = registerStructuredSelectionCatalogStore({
      read: () => ({ ...store, runtimeEnvironmentCatalogHydrated: true }),
      subscribe: () => () => {}
    })
  })
  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    const { cancelStructuredAgentLaunch, retireStructuredAgentSessionLaunchCancellationTombstone } =
      await import('./structured-agent-session-launch')
    for (const sessionId of ['codex-session-1', 'codex-session-2']) {
      cancelStructuredAgentLaunch('wt-1', sessionId)
      retireStructuredAgentSessionLaunchCancellationTombstone('wt-1', sessionId)
    }
    restoreCatalogStore?.()
  })

  let pickerMenu: typeof PickerMenu
  let dropdown: typeof Dropdown
  let tooltip: typeof Tooltip
  let quickLaunch: typeof QuickLaunch
  let actual: typeof StructuredLaunch
  beforeAll(async () => {
    actual = await vi.importActual<typeof StructuredLaunch>('./launch-structured-agent-session')
    ;[pickerMenu, dropdown, tooltip, quickLaunch] = await Promise.all([
      import('@/components/agent/AgentLaunchPickerMenu'),
      import('@/components/ui/dropdown-menu'),
      import('@/components/ui/tooltip'),
      import('@/components/tab-bar/QuickLaunchButton')
    ])
  })

  it.each(
    (['local', 'runtime:web-runtime'] as const).flatMap((host) =>
      (
        [
          ['claude', 'success'],
          ['claude', 'refusal'],
          ['claude', 'failure'],
          ['codex', 'success'],
          ['codex', 'refusal'],
          ['codex', 'failure']
        ] as const
      ).map(([agent, outcome]) => ({ host, agent, outcome }))
    )
  )(
    'keeps ordinary and picker $agent Chat inputs and $outcome endpoint outcomes equivalent on $host',
    async ({ host, agent, outcome }) => {
      store.settings.activeRuntimeEnvironmentId = host === 'local' ? null : 'web-runtime'
      const { captureNativeChatComposerFocusIntent } =
        await import('@/components/native-chat/use-native-chat-composer-reveal-focus')
      const { AgentLaunchPickerMenu } = pickerMenu
      const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = dropdown
      const { TooltipProvider } = tooltip
      const { useTabAgentMenuLaunch } = quickLaunch
      const launcher = await import('./launch-agent-in-new-tab')
      const dispatch = vi.spyOn(launcher, 'launchAgentInNewTab')
      const { launchAgentInNewTab } = launcher
      const { resetStructuredAgentLaunchRegistryForTests } =
        await import('./agent-session/launch/structured-agent-session-launch-registry')
      const { resetStructuredAgentLaunchPersistenceForTests } =
        await import('./agent-session/launch/structured-agent-session-launch-persistence')
      const { agentPickerChoiceSeeds, agentPickerEntriesFromRows } =
        await import('../../../shared/agent-launch-picker')
      store.settings.nativeChatSessionOptions = {
        [agent]: {
          model: 'saved-unknown-model',
          valuesByModel: { 'saved-unknown-model': { effort: 'high' } }
        }
      }
      store.settings.nativeChatProviders = { [agent]: false }
      const rows = buildNewTabAgentMenuRows({
        settings: store.settings,
        detectedOnHost: [agent],
        chatAgents: [agent],
        hostChatAnswer: () => 'yes',
        chatProgram: () => 'available'
      }).map((row) => ({ ...row, executionHostId: host }))
      expect(rows).toEqual([{ agent, kind: 'cli', chat: true, executionHostId: host }])
      const entry = agentPickerEntriesFromRows(
        rows,
        [agent],
        (selected) => agentPickerChoiceSeeds(selected, store.settings),
        (selected) => selected
      )[0]
      expect(entry.defaultSurface).toBe('terminal')
      expect(entry.surfaces).toEqual(['chat', 'terminal'])
      Object.assign(entry, {
        defaultsPending: true,
        structuredDefaultsPending: true,
        arguments: undefined,
        terminal: {},
        structured: {}
      })
      // The searched setup matches the saved choices so endpoint parity includes search intent.
      entry.catalog = {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          {
            id: 'saved-unknown-model',
            label: 'Saved model',
            isDefault: true,
            efforts: [{ value: 'high', label: 'High' }]
          }
        ]
      }
      function Menu() {
        const runLaunch = useTabAgentMenuLaunch({
          worktreeId: 'wt-1',
          groupId: 'group-1',
          onFocusTerminal: () => {}
        })
        return createElement(
          TooltipProvider,
          null,
          createElement(
            DropdownMenu,
            { defaultOpen: true, modal: false },
            createElement(DropdownMenuTrigger, null, 'New tab'),
            createElement(
              DropdownMenuContent,
              null,
              createElement(AgentLaunchPickerMenu, {
                entries: [entry],
                runLaunch,
                model: {
                  state: 'settled',
                  rows,
                  detection: {
                    detectedIds: [agent],
                    isLoading: false,
                    isRefreshing: false,
                    detectionFailed: false,
                    needsServerUpdate: false,
                    refresh: async () => [agent]
                  }
                }
              })
            )
          )
        )
      }
      mockCreateStructuredCodexSessionLaunchIntent.mockImplementation(
        (worktreeId, selectedAgent, host, resume, seed) => {
          const intent = actual.createStructuredAgentSessionLaunchIntent(
            worktreeId,
            selectedAgent,
            host,
            resume,
            seed,
            false
          )
          return {
            ...intent,
            sessionId: 'codex-session-1',
            params: {
              ...intent.params,
              envelope: structuredLaunchIntent(worktreeId).params.envelope
            }
          }
        }
      )
      const error =
        outcome === 'refusal'
          ? new launchErrorMocks.StructuredAgentSessionCreateRefusalError('provider unavailable')
          : new Error('connection failed')
      const perform = async (picker: false | 'ordinary' | 'searched') => {
        resetStructuredAgentLaunchRegistryForTests()
        resetStructuredAgentLaunchPersistenceForTests()
        mockLaunchStructuredCodexSession.mockClear()
        mockCreateTab.mockClear()
        mockToastError.mockClear()
        if (outcome === 'failure') {
          store.unifiedTabsByWorktree = {}
          mockRefreshLocalStructuredSessionTabs.mockResolvedValue([])
        }
        const preparationErrors: unknown[] = []
        mockLaunchStructuredCodexSession.mockImplementation(async (intent) => {
          await Promise.resolve()
          intent.createMessageSupport = true
          try {
            expect(intent.prepareCreate).toBeTypeOf('function')
            intent.prepareCreate!(false)
            expect(intent.createPrepared).toBe(true)
          } catch (error) {
            preparationErrors.push(error instanceof Error ? error.stack : error)
            throw error
          }
          if (outcome !== 'success') {
            throw error
          }
          return { sessionId: intent.sessionId, fence: 1 }
        })
        dispatch.mockClear()
        if (picker) {
          const view = render(createElement(Menu))
          if (picker === 'searched') {
            fireEvent.change(view.getByPlaceholderText('Search agents and setups…'), {
              target: { value: 'saved-unknown-model high' }
            })
          }
          fireEvent.click(
            document.querySelector<HTMLButtonElement>(`button[aria-label="Configure ${agent}"]`)!
          )
          expect(mockLaunchStructuredCodexSession).not.toHaveBeenCalled()
          expect(document.querySelector('textarea')).toHaveProperty('disabled', true)
          expect(document.body.textContent).toContain('Launch terminal')
          expect(
            [...document.querySelectorAll('button')].find(
              (button) => button.textContent === 'Launch terminal'
            )?.className
          ).toContain('bg-primary')
          fireEvent.click(
            [...document.querySelectorAll('button')].find(
              (button) => button.textContent === 'Launch chat'
            )!
          )
        } else {
          launchAgentInNewTab({
            requestId: `equivalent-${agent}-${outcome}`,
            agent,
            worktreeId: 'wt-1',
            groupId: 'group-1',
            requestedSurface: 'chat',
            selectedExecutionHostId: host,
            focusIntent: captureNativeChatComposerFocusIntent()
          })
        }
        const call = dispatch.mock.results.at(-1)
        const result = call?.type === 'return' ? call.value : undefined
        const settlement = await result?.structuredSettlement
        cleanup()
        expect(preparationErrors).toEqual([])
        const intent = mockLaunchStructuredCodexSession.mock.calls[0]?.[0]
        return {
          surface: result?.surface,
          settlement,
          target: intent?.target,
          params: intent?.params,
          seed: intent?.seedOptions,
          explicit: intent?.explicitLaunchOptions,
          terminalCalls: mockCreateTab.mock.calls,
          errors: mockToastError.mock.calls
        }
      }
      const ordinary = await perform(false)
      const picker = await perform('ordinary')
      expect(picker).toEqual(ordinary)
      const searched = await perform('searched')
      expect(searched).toMatchObject({
        surface: ordinary.surface,
        settlement: ordinary.settlement,
        target: ordinary.target,
        errors: ordinary.errors,
        terminalCalls: []
      })
      expect(searched.params).toMatchObject({
        agent,
        worktree: 'id:wt-1',
        options: { model: 'saved-unknown-model', effort: 'high' }
      })
      expect(searched.explicit).toMatchObject({ model: 'saved-unknown-model', effort: 'high' })
      dispatch.mockRestore()
      expect(picker.target).toEqual(
        host === 'local' ? { kind: 'local' } : { kind: 'environment', environmentId: 'web-runtime' }
      )
      expect(picker.params).toMatchObject({
        agent,
        worktree: 'id:wt-1'
      })
      expect(picker.params).not.toHaveProperty('options')
      expect(picker.explicit).toBeUndefined()
      if (host === 'local') {
        expect(picker.seed).toMatchObject({ model: 'saved-unknown-model', effort: 'high' })
      } else {
        expect(picker.seed).toBeUndefined()
      }
      expect(picker.terminalCalls).toEqual([])
      expect(picker.settlement?.kind).toBe(
        outcome === 'success'
          ? 'structured'
          : outcome === 'refusal'
            ? 'failed'
            : 'visibility-unknown'
      )
    }
  )

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
    store.settings.nativeChatSessionOptions = {
      codex: {
        model: 'gpt-5.6-sol',
        valuesByModel: { 'gpt-5.6-sol': { effort: 'medium' } }
      }
    }
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
    store.unifiedTabsByWorktree = {}
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
      setHostCapabilities(capabilities)
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
    store.settings.experimentalNativeChat = false
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
    expect(store.unifiedTabsByWorktree['wt-1']).toContainEqual(
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
        new Promise<{ sessionId: string; fence: number }>((resolve) => (resolveLaunch = resolve))
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
    store.unifiedTabsByWorktree = {}
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
    expect(store.unifiedTabsByWorktree['wt-1']).toContainEqual(
      expect.objectContaining({ contentType: 'agent-session', entityId: 'codex-session-1' })
    )
    expect(mockRefreshLocalStructuredSessionTabs).not.toHaveBeenCalled()
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('re-checks a chat whose visibility proof is unknown through its own Retry, with its own intent', async () => {
    store.unifiedTabsByWorktree = {}
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
        store.unifiedTabsByWorktree['wt-1'] = [
          {
            id: `structured-agent-session-${firstIntent.sessionId}`,
            contentType: 'agent-session',
            entityId: firstIntent.sessionId,
            worktreeId: 'wt-1',
            groupId: 'group-1'
          }
        ]
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
    expect(store.unifiedTabsByWorktree['wt-1']?.map((tab) => tab.entityId)).toEqual(
      expect.arrayContaining([firstIntent.sessionId, secondIntent.sessionId])
    )
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
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-a', path: '/repo' }]
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
    store.repos = [{ id: 'repo-1', connectionId: 'runtime-ssh-a', path: '/repo' }]
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
