// @vitest-environment happy-dom
import {
  mocks,
  LOCAL_TARGET,
  answer,
  mutateWith,
  ATTACHED,
  REOPENED,
  HOST_CATALOG,
  currentValue,
  renderOptions,
  descriptor,
  LIVE_OPTIONS,
  SAVED_LIST,
  tick
} from './use-structured-agent-session-options.test-fixture'
import { act, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/agent-session-options-result'
import { structuredAgentSessionMessageSelection } from '../../../../shared/agent-session/options/structured-agent-session-option-view'
import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'
import {
  resetHostModelCatalogSnapshotsForTests,
  recordHostModelCatalogSnapshot
} from '@/runtime/host-model-catalog-snapshots'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import { subscribeStructuredAgentSessionStatus } from '@/runtime/structured-agent-session-client'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY,
  AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY
} from '../../../../shared/agent-session/agent-session-permission-modes-capability'

it('keeps known pickers writable after a restarted process options read fails', async () => {
  forgetStructuredSessionSelection('session-1')
  resetHostModelCatalogSnapshotsForTests()
  mocks.call.mockReset()
  mocks.pick.mockReset()
  mocks.coherentCatalog = true
  mocks.sendSelection = false
  setLocalRuntimeCapabilitiesForTests([
    AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY,
    AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY
  ])
  const failed = Promise.withResolvers<unknown>()
  let reads = 0
  answer({
    modelCatalog: () => Promise.resolve(SAVED_LIST),
    options: () =>
      ++reads === 1
        ? Promise.resolve({
            ...LIVE_OPTIONS,
            models: LIVE_OPTIONS.models.map((model) => ({
              ...model,
              efforts: [{ value: 'medium', label: 'Medium' }]
            })),
            current: { ...LIVE_OPTIONS.current, effort: 'medium', permissionMode: 'ask' }
          })
        : failed.promise
  })
  const { result, rerender, unmount } = renderOptions(ATTACHED, mutateWith(async () => null).mutate)
  try {
    await waitFor(() =>
      expect(result.current.sendSource.optionStateRef.current.optionsAnswerPresent).toBe(true)
    )
    const beforeRestart = reads
    rerender({ ...ATTACHED, fence: 2 })
    await act(async () => {
      failed.reject(new Error('host timeout'))
      await tick()
    })
    await waitFor(() => expect(reads).toBe(beforeRestart + 3))
    for (const id of ['model', 'effort', 'permissionMode']) {
      expect(descriptor(result.current.optionSnapshot, id)?.settable, id).toBe(true)
    }
    mocks.pick.mockResolvedValue({
      key: 'model',
      value: 'gpt-5.6-luna',
      options: { model: 'gpt-5.6-luna' }
    })
    let applied = false
    await act(async () => {
      applied = await result.current.setStructuredOption('model', 'gpt-5.6-luna')
    })
    expect(applied).toBe(true)
    expect(mocks.pick).toHaveBeenCalled()
  } finally {
    unmount()
    forgetStructuredSessionSelection('session-1')
    setLocalRuntimeCapabilitiesForTests(null)
  }
})

it.each([false, undefined])(
  'retires a draft observation before late discovery (next fact: %s)',
  async (sessionNeverStarted) => {
    forgetStructuredSessionSelection('session-1')
    resetHostModelCatalogSnapshotsForTests()
    mocks.call.mockReset()
    mocks.enqueue.mockReset()
    mocks.coherentCatalog = true
    mocks.sendSelection = true
    const pending = Promise.withResolvers<AgentSessionOptionsResult>()
    const catalog = Promise.withResolvers<typeof HOST_CATALOG>()
    let reads = 0
    const current: AgentSessionOptionsResult = {
      models: [],
      modelsKnown: false,
      sessionNeverStarted: true,
      current: { defaulted: [], acceptedInputSources: {} }
    }
    answer({
      options: () =>
        ++reads === 1
          ? Promise.resolve(current)
          : reads === 2
            ? pending.promise
            : Promise.resolve({ ...current, sessionNeverStarted }),
      modelCatalog: () => catalog.promise
    })
    const view = renderOptions({ ...REOPENED, agent: 'claude' }, vi.fn())
    await waitFor(() =>
      expect(view.result.current.sendSource.optionStateRef.current.optionsAnswerPresent).toBe(true)
    )
    view.rerender({ ...REOPENED, agent: 'claude', turnId: 'pending-turn' })
    await waitFor(() => expect(reads).toBe(2))
    view.rerender({ ...REOPENED, agent: 'claude', turnId: 'newer-turn' })
    await act(async () => pending.resolve(current))
    await waitFor(() =>
      expect(view.result.current.sendSource.optionStateRef.current.sessionNeverStarted).toBe(
        sessionNeverStarted
      )
    )
    await act(async () => catalog.resolve({ ...HOST_CATALOG, listingNamesConfiguredModel: true }))
    await tick()
    expect(currentValue(view.result.current.optionSnapshot, 'model')).toBeNull()
    expect(currentValue(view.result.current.optionSnapshot, 'effort')).toBeNull()
    expect(
      structuredAgentSessionMessageSelection(view.result.current.sendSource.optionStateRef.current)
    ).toEqual({})
    expect(mocks.enqueue).not.toHaveBeenCalled()
    view.unmount()
  }
)

it.each(['options-first', 'catalog-first', 'cached'] as const)(
  'names an auto-opened never-started chat without local launch intent (%s)',
  async (order) => {
    forgetStructuredSessionSelection('session-1')
    resetHostModelCatalogSnapshotsForTests()
    resetStructuredAgentSessionStatusFeedsForTests()
    vi.mocked(subscribeStructuredAgentSessionStatus).mockClear()
    mocks.call.mockReset()
    mocks.coherentCatalog = true
    mocks.sendSelection = true
    const options = Promise.withResolvers<AgentSessionOptionsResult>()
    const catalog = Promise.withResolvers<AgentSessionModelCatalogResult>()
    mocks.call.mockImplementation(
      (_target: unknown, method: string, params: { waitForListing?: boolean }) =>
        method === 'agentSession.options'
          ? options.promise
          : method === 'agentSession.modelCatalog'
            ? params.waitForListing || order !== 'options-first'
              ? catalog.promise
              : Promise.resolve({ origin: 'unknown', listingInProgress: true })
            : new Promise(() => {})
    )
    const answer: AgentSessionOptionsResult = {
      models: [],
      modelsKnown: false,
      sessionNeverStarted: true,
      current: { defaulted: [], acceptedInputSources: {} }
    }
    const discovered: AgentSessionModelCatalogResult = {
      origin: 'probe',
      fetchedAt: 1,
      listingNamesConfiguredModel: true,
      modelsDifferByWorkspace: true,
      models: [
        {
          id: 'opus',
          label: 'Opus',
          isDefault: true,
          defaultEffort: 'medium',
          declaredDefaultEffort: 'medium',
          efforts: [
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    }
    if (order === 'cached') {
      recordHostModelCatalogSnapshot(LOCAL_TARGET, 'claude', '', discovered)
    }
    const view = renderOptions({ ...REOPENED, agent: 'claude' }, vi.fn())
    const value = (id: string) => currentValue(view.result.current.optionSnapshot, id)
    expect(value('model')).toBeNull()
    if (order === 'options-first') {
      await act(async () => options.resolve(answer))
      expect(value('model')).toBeNull()
      await act(async () => catalog.resolve(discovered))
    } else {
      await act(async () => catalog.resolve(discovered))
      expect(value('model')).toBeNull()
      await act(async () => options.resolve(answer))
    }
    await waitFor(() => expect([value('model'), value('effort')]).toEqual(['opus', 'medium']))
    expect(descriptor(view.result.current.optionSnapshot, 'model')?.valueSource).toBe('default')
    const state = view.result.current.sendSource.optionStateRef.current
    expect(state.record.values.model).toBeUndefined()
    expect(state.record.values.effort).toBeUndefined()
    expect(state.acceptedInputSources).toEqual({})
    expect(view.result.current.capture().selection).toEqual({})
    if (order === 'options-first') {
      mocks.call.mockImplementation((_target: unknown, method: string) =>
        method === 'agentSession.options'
          ? Promise.resolve({
              ...answer,
              current: { model: 'opus', defaulted: ['model'], acceptedInputSources: {} }
            })
          : catalog.promise
      )
      await act(async () =>
        vi
          .mocked(subscribeStructuredAgentSessionStatus)
          .mock.calls.at(-1)?.[1]({
            type: 'status',
            session: {
              sessionId: 'session-1',
              workspaceId: 'wt-1',
              agent: 'claude',
              status: 'idle',
              latestPrompt: '',
              updatedAt: 1
            }
          })
      )
      await waitFor(() =>
        expect(
          view.result.current.sendSource.optionStateRef.current.record.values.model?.source
        ).toBe('default')
      )
      expect([value('model'), value('effort')]).toEqual(['opus', 'medium'])
      expect(view.result.current.capture().selection).toEqual({})
      mocks.call.mockImplementation((_target: unknown, method: string) =>
        method === 'agentSession.options'
          ? Promise.resolve(answer)
          : Promise.reject(new Error('catalog unavailable'))
      )
      await act(async () => view.result.current.optionSurface.demandModelCatalog?.())
      await waitFor(() => expect(value('model')).toBeNull())
    }
    view.unmount()
  }
)
