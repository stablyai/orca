// @vitest-environment happy-dom

import {
  mockCreateTab,
  mockCreateStructuredCodexSessionLaunchIntent,
  mockLaunchStructuredCodexSession,
  mockRefreshLocalStructuredSessionTabs,
  mockToastError,
  structuredLaunchIntent,
  liveStore,
  currentLaunchSettings,
  main,
  mockCallStructuredAgentSession,
  mockCreateSupport,
  launchErrorMocks,
  mockWaitForAgentReady,
  mockPasteDraftWhenAgentReady,
  mockRetryStructuredAgentSessionLaunchIntent
} from './launch-agent-structured-chat-test-fixture'
import type * as PickerMenu from '@/components/agent/AgentLaunchPickerMenu'
import type * as Dropdown from '@/components/ui/dropdown-menu'
import type * as Tooltip from '@/components/ui/tooltip'
import type * as QuickLaunch from '@/components/tab-bar/QuickLaunchButton'
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { buildNewTabAgentMenuRows } from '../../../shared/agent-launch-picker-rows'
import type * as StructuredLaunch from './launch-structured-agent-session'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as registry from './agent-session/launch/structured-agent-session-launch-registry'
import { cancelStructuredAgentLaunch } from './structured-agent-session-launch'
import { structuredLaunchSelectionController } from './structured-agent-session-launch-options'
import { forgetStructuredSessionSelection } from './structured-agent-session-selection-controller'
import * as rpc from '@/runtime/runtime-rpc-client'
import { isPendingTab } from '@/runtime/layout-owner-pending-tabs'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { nativeChatComposerDraftWritesSettled } from '@/components/native-chat/native-chat-composer-draft-persistence'
import type { SelectionOperation } from '../../../shared/structured-agent-session-selection-operations'

// No initial chat mode proves availability rejection preceded terminal-tab adoption.
describe('structured chat adoption guard on the launch path', () => {
  beforeEach(() => {
    const originalRow = liveStore().getState().getTab('structured-agent-session-codex-session-1')
    expect(originalRow).not.toHaveProperty('executionHostId')
    expect(originalRow).not.toHaveProperty('agentSessionAgent')
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
      const store = liveStore()
      store.setState({
        settings: {
          ...currentLaunchSettings(),
          activeRuntimeEnvironmentId: host === 'local' ? null : 'web-runtime'
        }
      })
      const { captureNativeChatComposerFocusIntent } =
        await import('@/components/native-chat/use-native-chat-composer-reveal-focus')
      const { AgentLaunchPickerMenu } = pickerMenu
      const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = dropdown
      const { TooltipProvider } = tooltip
      const { useTabAgentMenuLaunch } = quickLaunch
      const launcher = await import('./launch-agent-in-new-tab')
      const owned: ReturnType<typeof launcher.launchAgentInNewTab>[] = []
      const originalLaunch = launcher.launchAgentInNewTab
      const dispatch = vi.spyOn(launcher, 'launchAgentInNewTab').mockImplementation((args) => {
        const result = originalLaunch(args)
        owned.push(result)
        return result
      })
      const warnings = vi.spyOn(console, 'warn')
      const rawRpc = vi.spyOn(rpc, 'callRuntimeRpc')
      const states = new Set<registry.StructuredLaunchState>()
      const promises = new Set<registry.StructuredLaunchState['promise']>()
      const settled = new Set<registry.StructuredLaunchState['promise']>()
      const controllers = new Map<
        ReturnType<typeof structuredLaunchSelectionController>,
        registry.StructuredLaunchState['intent']
      >()
      const optionWork = new Set<SelectionOperation>()
      const install = registry.setStructuredLaunchState
      vi.spyOn(registry, 'setStructuredLaunchState').mockImplementation((state) => {
        states.add(state)
        const promise = state.promise
        promises.add(promise)
        void promise.then(
          () => settled.add(promise),
          () => settled.add(promise)
        )
        controllers.set(structuredLaunchSelectionController(state), state.intent)
        install(state)
      })
      let activeCreates = 0
      const drain = async () => {
        await Promise.allSettled(promises)
        await Promise.allSettled(
          owned.flatMap((result) => [result?.structuredSettlement, result?.promptDeliveryResult])
        )
        await Promise.allSettled(
          [...states].flatMap((state) => [...state.callers.promptDeliveryResults])
        )
        for (const controller of controllers.keys()) {
          for (const operation of controller.pending()) {
            optionWork.add(operation)
          }
        }
        await Promise.allSettled(
          [...optionWork].flatMap((operation) => [operation.result, operation.request])
        )
        await Promise.all([...controllers.keys()].map((controller) => controller.drain()))
        const raw = [
          mockCreateSupport,
          mockLaunchStructuredCodexSession,
          mockRefreshLocalStructuredSessionTabs,
          mockCallStructuredAgentSession,
          rawRpc
        ].flatMap<unknown>((mock) =>
          mock.mock.results.flatMap<unknown>((result) =>
            result.type === 'return' ? [result.value] : []
          )
        )
        const pendingRaw = new Set(
          raw.filter((value): value is Promise<unknown> => value instanceof Promise)
        )
        for (const request of pendingRaw) {
          void request.then(
            () => pendingRaw.delete(request),
            () => pendingRaw.delete(request)
          )
        }
        await Promise.allSettled(pendingRaw)
        expect(pendingRaw.size).toBe(0)
        await main.settle()
        await nativeChatComposerDraftWritesSettled()
        expect(activeCreates).toBe(0)
        expect(layoutApplyTestTransport.pendingCount).toBe(0)
        expect(isPendingTab('structured-agent-session-codex-session-1')).toBe(false)
        expect(
          warnings.mock.calls.filter(
            ([message]) => message === '[layout-owner] pending tab waiter threw:'
          )
        ).toEqual([])
      }
      const finish = async () => {
        try {
          for (const state of states) {
            if (
              !settled.has(state.promise) &&
              registry.getStructuredLaunchStateBySessionId(state.intent.sessionId) === state
            ) {
              expect(state.intent.worktreeId).toBe('wt-1')
              expect(state.intent.executionHostId).toBe(host)
              cancelStructuredAgentLaunch('wt-1', state.intent.sessionId)
            }
          }
        } finally {
          try {
            await drain()
          } finally {
            try {
              cleanup()
            } finally {
              for (const state of states) {
                if (registry.deleteStructuredLaunchStateIfCurrent(state)) {
                  registry.notifyStructuredLaunchListeners()
                }
              }
              try {
                await drain()
              } finally {
                registry.retireStructuredAgentSessionLaunchCancellationTombstone(
                  'wt-1',
                  'codex-session-1'
                )
                await drain()
              }
            }
          }
        }
        expect(registry.getStructuredLaunchStateBySessionId('codex-session-1')).toBeUndefined()
        expect(registry.getPersistedStructuredAgentLaunchRecord('codex-session-1')).toBeUndefined()
        expect(
          registry.hasStructuredAgentSessionLaunchCancellationTombstone('wt-1', 'codex-session-1')
        ).toBe(false)
      }
      const { launchAgentInNewTab } = launcher
      const { resetStructuredAgentLaunchRegistryForTests } =
        await import('./agent-session/launch/structured-agent-session-launch-registry')
      const { resetStructuredAgentLaunchPersistenceForTests } =
        await import('./agent-session/launch/structured-agent-session-launch-persistence')
      const { agentPickerChoiceSeeds, agentPickerEntriesFromRows } =
        await import('../../../shared/agent-launch-picker')
      store.setState({
        settings: {
          ...currentLaunchSettings(),
          nativeChatPermissionMode: 'ask',
          nativeChatSessionOptions: {
            [agent]: {
              model: 'saved-unknown-model',
              valuesByModel: { 'saved-unknown-model': { effort: 'high' } }
            }
          },
          nativeChatProviders: { [agent]: false }
        }
      })
      const rows = buildNewTabAgentMenuRows({
        settings: store.getState().settings,
        detectedOnHost: [agent],
        chatAgents: [agent],
        hostChatAnswer: () => 'yes',
        chatProgram: () => 'available'
      }).map((row) => ({ ...row, executionHostId: host }))
      expect(rows).toEqual([{ agent, kind: 'cli', chat: true, executionHostId: host }])
      const entry = agentPickerEntriesFromRows(
        rows,
        [agent],
        (selected) => agentPickerChoiceSeeds(selected, store.getState().settings),
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
                runLaunch
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
          store.setState({
            unifiedTabsByWorktree: {},
            groupsByWorktree: {},
            layoutByWorktree: {},
            activeGroupIdByWorktree: {}
          })
          expect(store.getState().getTab('structured-agent-session-codex-session-1')).toBeNull()
          mockRefreshLocalStructuredSessionTabs.mockResolvedValue([])
        }
        const preparationErrors: unknown[] = []
        mockLaunchStructuredCodexSession.mockImplementation(async (intent) => {
          activeCreates++
          try {
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
          } finally {
            activeCreates--
          }
        })
        dispatch.mockClear()
        try {
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
          expect(states.size).toBeGreaterThan(0)
          await main.settle()
          expect(preparationErrors).toEqual([])
          const intent = mockLaunchStructuredCodexSession.mock.calls[0]?.[0]
          if (outcome === 'success') {
            for (const controller of controllers.keys()) {
              expect(controller.isCurrent()).toBe(true)
            }
          }
          expect(store.getState().getTab('structured-agent-session-codex-session-1')).toMatchObject(
            {
              id: 'structured-agent-session-codex-session-1',
              entityId: 'codex-session-1',
              contentType: 'agent-session',
              worktreeId: 'wt-1'
            }
          )
          return {
            surface: result?.surface,
            settlement,
            target: intent?.target,
            params: intent?.params,
            seed: intent?.seedOptions,
            explicit: intent?.explicitLaunchOptions,
            terminalCalls: mockCreateTab.mock.calls.map((args) => [...args]),
            errors: mockToastError.mock.calls.map((args) => [...args])
          }
        } finally {
          await finish()
        }
      }
      try {
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
          worktree: 'id:wt-1'
        })
        expect(searched.params?.options).toEqual(
          host === 'local'
            ? { model: 'saved-unknown-model', effort: 'high', permissionMode: 'ask' }
            : { model: 'saved-unknown-model', effort: 'high' }
        )
        expect(searched.explicit).toEqual({ model: 'saved-unknown-model', effort: 'high' })
        dispatch.mockRestore()
        expect(picker.target).toEqual(
          host === 'local'
            ? { kind: 'local' }
            : { kind: 'environment', environmentId: 'web-runtime' }
        )
        expect(picker.params).toMatchObject({
          agent,
          worktree: 'id:wt-1'
        })
        if (host === 'local' && agent === 'claude') {
          expect(picker.params?.options).toEqual({ model: 'saved-unknown-model', effort: 'high' })
        } else {
          expect(picker.params).not.toHaveProperty('options')
        }
        expect(picker.params).not.toHaveProperty('optionsMode')
        expect(picker.explicit).toBeUndefined()
        if (host === 'local') {
          expect(picker.seed).toEqual({
            model: 'saved-unknown-model',
            effort: 'high',
            permissionMode: 'ask'
          })
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
      } finally {
        try {
          await finish()
        } finally {
          try {
            for (const [controller, intent] of controllers) {
              for (const operation of controller.pending()) {
                optionWork.add(operation)
              }
              forgetStructuredSessionSelection(intent.sessionId, intent.target)
            }
          } finally {
            await drain()
          }
          for (const controller of controllers.keys()) {
            expect(controller.isCurrent()).toBe(false)
          }
        }
      }
    }
  )
})
