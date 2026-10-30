// @vitest-environment happy-dom
import {
  mocks,
  LOCAL_TARGET,
  PAIRED_TARGET,
  FakeRpcCallError,
  answer,
  mutateWith,
  PROVISIONAL,
  PUBLISHED_UNATTACHED,
  ATTACHED,
  REOPENED,
  renderOptions,
  descriptor,
  currentValue,
  modelChoiceCount,
  setOptionCalls,
  HOST_CATALOG,
  LIVE_OPTIONS,
  SAVED_LIST,
  SEED,
  tick,
  type RenderProps
} from './use-structured-agent-session-options.test-fixture'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import { act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  structuredAgentSessionSendSelection,
  structuredAgentSessionMessageSelection
} from '../../../../shared/structured-agent-session-option-view'
import {
  forgetStructuredSessionSelection,
  structuredSessionSelectionController
} from '@/lib/structured-agent-session-selection-controller'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
describe('useStructuredAgentSessionOptions', () => {
  beforeEach(() => {
    mocks.sendSelection = false
    forgetStructuredSessionSelection('session-1')
    mocks.call.mockReset()
    mocks.enqueue.mockReset()
    mocks.hold.mockReset()
    mocks.toastError.mockReset()
    mocks.coherentCatalog = false
    resetHostModelCatalogSnapshotsForTests()
  })

  it('keeps the latest dependent menu after same-stamp receipts and an older delayed answer', async () => {
    const menu = (model: string, effort?: string): AgentSessionOptionsResult => ({
      models: ['family', 'newer'].map((id) => ({
        id,
        label: id,
        isDefault: false,
        effortsKnown: id === model && !!effort ? undefined : (false as const),
        efforts:
          id === model && effort ? [effort, 'off'].map((value) => ({ value, label: value })) : []
      })),
      current: { model, ...(effort ? { effort } : {}) }
    })
    const initial = menu('family')
    const older = Promise.withResolvers<AgentSessionOptionsResult>()
    const latest = Promise.withResolvers<AgentSessionOptionsResult>()
    let reads = 0
    answer({
      options: () =>
        [Promise.resolve(initial), older.promise, latest.promise][reads++] ?? latest.promise
    })
    const { mutate, calls } = mutateWith(async () => null)
    calls
      .mockResolvedValueOnce({ options: { model: 'family' } })
      .mockResolvedValue({ options: { model: 'newer' } })
    const { result, rerender, unmount } = renderOptions(
      { ...REOPENED, agent: 'antigravity' },
      mutate
    )
    await waitFor(() => expect(currentValue(result.current.optionSnapshot, 'model')).toBe('family'))
    expect(descriptor(result.current.optionSnapshot, 'effort')).toBeUndefined()
    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'family')).toBe(true)
    })
    await waitFor(() => expect(reads).toBe(2))
    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'newer')).toBe(true)
    })
    expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(true)
    expect(descriptor(result.current.optionSnapshot, 'effort')).toBeUndefined()
    // Returning to the view starts a current reader while the superseded response is still in flight.
    rerender({ ...REOPENED, agent: 'antigravity', hidden: true })
    rerender({ ...REOPENED, agent: 'antigravity' })
    await waitFor(() => expect(reads).toBe(3))
    await act(async () => latest.resolve(menu('newer', 'high')))
    await waitFor(() => expect(currentValue(result.current.optionSnapshot, 'effort')).toBe('high'))
    await act(async () => older.resolve(menu('family', 'low')))
    expect(currentValue(result.current.optionSnapshot, 'model')).toBe('newer')
    expect(descriptor(result.current.optionSnapshot, 'effort')).toMatchObject({
      settable: true,
      kind: {
        type: 'select',
        currentValue: 'high',
        choices: [{ value: 'high' }, { value: 'off' }]
      }
    })
    unmount()
  })

  it('retains a queried seed-catalog base through same-session attach and later metadata', async () => {
    mocks.coherentCatalog = true
    let landCatalog = (_value: unknown): void => {}
    const catalog = new Promise((resolve) => (landCatalog = resolve))
    let reads = 0
    answer({
      modelCatalog: () => catalog,
      options: () =>
        ++reads === 1
          ? Promise.resolve({
              ...LIVE_OPTIONS,
              current: { model: 'gpt-5.5', defaulted: ['model'], acceptedInputSources: {} }
            })
          : new Promise(() => {})
    })
    const stale = { model: 'old-unlisted', effort: 'high' }
    const props = { ...ATTACHED, launchSeedOptions: stale }
    const { result, rerender, unmount } = renderOptions(props, mutateWith(async () => null).mutate)
    const capture = () => {
      const { optionStateRef, optionView } = result.current.sendSource
      return structuredAgentSessionMessageSelection(
        optionView(optionStateRef.current, stale, stale)
      )
    }
    await waitFor(() =>
      expect(result.current.sendSource.optionStateRef.current.optionsAnswerPresent).toBe(true)
    )
    expect(result.current.sendSource.optionStateRef.current.catalogSource).toBe('seed')
    expect(capture()).toEqual({})
    rerender({ ...props, fence: 2 })
    expect(capture()).toEqual({})
    expect(result.current.sendSource.optionStateRef.current.optionsAnswerPresent).toBe(true)
    await act(async () => {
      landCatalog({ ...SAVED_LIST, listingNamesConfiguredModel: true })
      await tick()
    })
    expect(capture()).toEqual({})
    await act(async () => {
      structuredSessionSelectionController(LOCAL_TARGET, 'session-1', 'codex').issue(
        'effort',
        'low',
        'gpt-5.5'
      )
    })
    expect(capture()).toEqual({ effort: 'low' })
    rerender({ ...props, fence: 3 })
    expect(capture()).toEqual({ effort: 'low' })
    unmount()
    forgetStructuredSessionSelection('session-1')
  })

  it('upgrades the seed with the host catalog while the live read is still pending', async () => {
    answer({ modelCatalog: () => Promise.resolve(HOST_CATALOG) })
    const { result, unmount } = renderOptions(ATTACHED, mutateWith(async () => null).mutate)
    await waitFor(() => {
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-hosted')
      expect(descriptor(result.current.optionSnapshot, 'model')?.valueSource).toBe('default')
    })
    unmount()
  })

  it('reads no host catalog for a hidden retained tab until it is shown', async () => {
    answer({ modelCatalog: () => Promise.resolve(HOST_CATALOG) })
    const { rerender, unmount } = renderOptions(
      { ...REOPENED, hidden: true },
      mutateWith(async () => null).mutate
    )
    await tick()
    // Hidden restored tabs must not start background listing processes on startup.
    expect(mocks.call).not.toHaveBeenCalled()
    rerender(REOPENED)
    await waitFor(() =>
      expect(mocks.call.mock.calls.map(([, method]) => method)).toContain(
        'agentSession.modelCatalog'
      )
    )
    unmount()
  })

  it('lists the host catalog for a reopened chat but names no model until it reports', async () => {
    answer({ modelCatalog: () => Promise.resolve(HOST_CATALOG) })
    const { result, unmount } = renderOptions(REOPENED, mutateWith(async () => null).mutate)
    await waitFor(() => {
      const model = descriptor(result.current.optionSnapshot, 'model')
      expect(
        model?.kind.type === 'select' && model.kind.choices.some((c) => c.value === 'gpt-hosted')
      ).toBe(true)
    })
    // It may run a model picked in it rather than the listing's default.
    expect(currentValue(result.current.optionSnapshot, 'model')).toBeNull()
    unmount()
  })

  it('shows the host catalog but takes no pick before a reopened chat attaches', async () => {
    answer({ modelCatalog: () => Promise.resolve(HOST_CATALOG) })
    const unattached = { transportEnabled: true, fence: null }
    const { result, rerender, unmount } = renderOptions(
      unattached,
      mutateWith(async () => null).mutate
    )
    await waitFor(() => expect(modelChoiceCount(result.current.optionSnapshot)).toBeGreaterThan(0))
    // Without a holding launch or runtime fence, no path can apply the pick.
    expect(descriptor(result.current.optionSnapshot, 'model')).toMatchObject({
      settable: false,
      disabledReason: 'available-after-session-start'
    })
    rerender({ ...unattached, fence: 1 })
    expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(true)
    unmount()
  })

  it('treats method_not_found and forbidden as no list: the built-in one, naming nothing', async () => {
    for (const code of ['method_not_found', 'forbidden']) {
      answer({ modelCatalog: () => Promise.reject(new FakeRpcCallError(code)) })
      const { result, unmount } = renderOptions(
        { ...PROVISIONAL, launchSeedOptions: SEED },
        mutateWith(async () => null).mutate
      )
      await waitFor(() =>
        expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(true)
      )
      expect(modelChoiceCount(result.current.optionSnapshot)).toBeGreaterThan(0)
      // Wait for host labels instead of flashing built-in labels for saved picks.
      expect(currentValue(result.current.optionSnapshot, 'model')).toBeNull()
      unmount()
    }
  })

  it('refreshes inventory after a live answer while keeping the chat choice', async () => {
    let settleCatalog: ((value: unknown) => void) | undefined
    answer({
      options: () =>
        Promise.resolve(
          settleCatalog
            ? { ...LIVE_OPTIONS, models: [...HOST_CATALOG.models, ...LIVE_OPTIONS.models] }
            : LIVE_OPTIONS
        ),
      modelCatalog: () => new Promise((resolve) => (settleCatalog = resolve))
    })
    const { result, unmount } = renderOptions(ATTACHED, mutateWith(async () => null).mutate)
    await waitFor(() =>
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-5.5')
    )
    await act(async () => {
      if (!settleCatalog) {
        throw new Error('Host catalog request has not started')
      }
      settleCatalog(HOST_CATALOG)
      await tick()
    })
    const model = descriptor(result.current.optionSnapshot, 'model')
    expect(model?.kind.type === 'select' ? model.kind.currentValue : null).toBe('gpt-5.5')
    expect(
      model?.kind.type === 'select' &&
        model.kind.choices.some((choice) => choice.value === 'gpt-hosted')
    ).toBe(true)
    unmount()
  })

  describe('while the launch is provisional', () => {
    it('renders the launch seed and hands a pick to the launch without any RPC', async () => {
      answer({ modelCatalog: () => Promise.resolve(SAVED_LIST) })
      mocks.hold.mockReturnValue(new Promise(() => {}))
      const { mutate, calls } = mutateWith(async () => null)
      const { result, rerender, unmount } = renderOptions(
        { ...PROVISIONAL, launchSeedOptions: SEED },
        mutate
      )
      await waitFor(() =>
        expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-5.5')
      )
      expect(modelChoiceCount(result.current.optionSnapshot)).toBeGreaterThan(0)

      let accepted = false
      await act(async () => {
        accepted = await result.current.setStructuredOption('model', 'gpt-5.6-luna')
      })
      expect(accepted).toBe(true)
      expect(mocks.hold).toHaveBeenCalledWith(
        'session-1',
        'model',
        'gpt-5.6-luna',
        expect.anything()
      )
      // The launch owns the pick; the view renders what it holds.
      rerender({ ...PROVISIONAL, launchSeedOptions: SEED })
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-5.6-luna')
      expect(descriptor(result.current.optionSnapshot, 'model')?.valueSource).toBe('dispatched')
      expect(calls).not.toHaveBeenCalled()
      expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
        'agentSession.modelCatalog'
      ])
      expect(mocks.enqueue).not.toHaveBeenCalled()
      unmount()
    })

    it('names the worktree a new chat runs in, so its own config can withhold the default', async () => {
      answer({ modelCatalog: () => Promise.resolve(HOST_CATALOG) })
      const { unmount } = renderOptions(
        { ...PROVISIONAL, worktree: 'id:wt-1' },
        mutateWith(async () => null).mutate
      )
      await waitFor(() =>
        expect(mocks.call).toHaveBeenCalledWith(LOCAL_TARGET, 'agentSession.modelCatalog', {
          agent: 'codex',
          sessionId: 'session-1',
          worktree: 'id:wt-1'
        })
      )
      unmount()
      mocks.call.mockClear()
      renderOptions(
        { ...PROVISIONAL, launch: 'resume', worktree: 'id:wt-1' },
        mutateWith(async () => null).mutate
      ).unmount()
      expect(mocks.call).toHaveBeenCalledWith(LOCAL_TARGET, 'agentSession.modelCatalog', {
        agent: 'codex',
        sessionId: 'session-1'
      })
    })

    it('names the host catalog default when no selection is stored', async () => {
      answer({ modelCatalog: () => Promise.resolve(HOST_CATALOG) })
      const { result, unmount } = renderOptions(PROVISIONAL, mutateWith(async () => null).mutate)
      await waitFor(() =>
        expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-hosted')
      )
      unmount()
    })

    it('names no listed default for a new Claude chat, whose own settings pick the model', async () => {
      answer({ modelCatalog: () => Promise.resolve(HOST_CATALOG) })
      const claude = { ...PROVISIONAL, agent: 'claude' as const, worktree: 'id:wt-1' }
      const { result, rerender, unmount } = renderOptions(
        claude,
        mutateWith(async () => null).mutate
      )
      await waitFor(() => {
        const model = descriptor(result.current.optionSnapshot, 'model')
        expect(
          model?.kind.type === 'select' && model.kind.choices.some((c) => c.value === 'gpt-hosted')
        ).toBe(true)
      })
      expect(currentValue(result.current.optionSnapshot, 'model')).toBeNull()
      // New-chat reads include workspace identity so the host can resolve project overrides.
      expect(mocks.call).toHaveBeenCalledWith(LOCAL_TARGET, 'agentSession.modelCatalog', {
        agent: 'claude',
        sessionId: 'session-1',
        worktree: 'id:wt-1'
      })
      rerender({ ...claude, launchSeedOptions: { model: 'gpt-hosted' } })
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-hosted')
      unmount()
    })

    it('names no listed default for a resumed chat, only a model its launch sends', async () => {
      answer({ modelCatalog: () => Promise.resolve(HOST_CATALOG) })
      const resumed = { ...PROVISIONAL, launch: 'resume' as const }
      const { result, rerender, unmount } = renderOptions(
        resumed,
        mutateWith(async () => null).mutate
      )
      await waitFor(() => {
        const model = descriptor(result.current.optionSnapshot, 'model')
        expect(
          model?.kind.type === 'select' && model.kind.choices.some((c) => c.value === 'gpt-hosted')
        ).toBe(true)
      })
      // The resumed conversation may keep its own model rather than the listing's default.
      expect(currentValue(result.current.optionSnapshot, 'model')).toBeNull()
      rerender({ ...resumed, launchSeedOptions: { model: 'gpt-hosted' } })
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-hosted')
      unmount()
    })

    it('keeps the host catalog default through attach instead of blanking it', async () => {
      // Only the first catalog read answers; the re-read at the new fence never does.
      let catalogReads = 0
      answer({
        modelCatalog: () =>
          ++catalogReads === 1 ? Promise.resolve(HOST_CATALOG) : new Promise(() => {})
      })
      const { result, rerender, unmount } = renderOptions(
        PROVISIONAL,
        mutateWith(async () => null).mutate
      )
      await waitFor(() =>
        expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-hosted')
      )
      rerender(ATTACHED)
      expect(catalogReads).toBe(2)
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-hosted')
      unmount()
    })

    it('remembers a pick the launch applied as the next launch default', async () => {
      answer({ modelCatalog: () => Promise.resolve(SAVED_LIST) })
      mocks.hold.mockResolvedValue({ kind: 'accepted', options: { model: 'gpt-5.6-luna' } })
      const { result, unmount } = renderOptions(
        { ...PROVISIONAL, launchSeedOptions: SEED },
        mutateWith(async () => null).mutate
      )
      await waitFor(() =>
        expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(true)
      )
      await act(async () => {
        await result.current.setStructuredOption('model', 'gpt-5.6-luna')
      })
      await waitFor(() =>
        expect(mocks.enqueue).toHaveBeenCalledWith(LOCAL_TARGET, {
          type: 'apply-picks',
          agent: 'codex',
          picks: [{ modelId: 'gpt-5.6-luna', optionId: 'model', value: 'gpt-5.6-luna' }]
        })
      )
      expect(mocks.toastError).not.toHaveBeenCalled()
      unmount()
    })

    it('reports a pick the launch could not apply as a refused write and remembers nothing', async () => {
      answer({ modelCatalog: () => Promise.resolve(SAVED_LIST) })
      mocks.hold.mockResolvedValue({
        kind: 'refused',
        failure: { kind: 'refused', code: 'agent_session_operation_capacity' }
      })
      const { result, unmount } = renderOptions(
        { ...PROVISIONAL, launchSeedOptions: SEED },
        mutateWith(async () => null).mutate
      )
      await waitFor(() =>
        expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(true)
      )
      await act(async () => {
        await result.current.setStructuredOption('model', 'gpt-5.6-luna')
      })
      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith(
          "The setting wasn't changed. Orca on the computer running this chat has hit a request limit. Update Orca there, then try again."
        )
      )
      expect(mocks.enqueue).not.toHaveBeenCalled()
      unmount()
    })

    it('sends a pick made once the launch has published through the session, not the launch', async () => {
      answer({ modelCatalog: () => Promise.resolve(SAVED_LIST) })
      mocks.hold.mockReturnValue(null)
      const { mutate, calls } = mutateWith(async () => null)
      const { result, rerender, unmount } = renderOptions(
        { ...PUBLISHED_UNATTACHED, launchSeedOptions: SEED },
        mutate
      )
      await waitFor(() => expect(modelChoiceCount(result.current.optionSnapshot)).toBe(2))
      let accepted = true
      await act(async () => {
        accepted = await result.current.setStructuredOption('model', 'gpt-5.6-luna')
      })
      // After publication but before attach, neither launch holding nor fenced writes can accept picks.
      expect(accepted).toBe(false)
      expect(calls).not.toHaveBeenCalled()

      rerender({ ...ATTACHED, launchSeedOptions: SEED })
      await act(async () => {
        await result.current.setStructuredOption('model', 'gpt-5.6-luna')
      })
      expect(setOptionCalls(calls)).toEqual([{ key: 'model', value: 'gpt-5.6-luna' }])
      expect(mocks.hold).not.toHaveBeenCalled()
      unmount()
    })
  })

  describe('before the provider starts', () => {
    it('keeps a picked effort visible after a model pick during startup', async () => {
      answer({
        modelCatalog: async () => ({ origin: 'unknown' }),
        options: async () => ({
          models: ['opus', 'sonnet'].map((id) => ({
            id,
            label: id,
            efforts: ['low', 'high'].map((value) => ({ value, label: value }))
          })),
          current: { model: 'opus' }
        })
      })
      const { result, unmount } = renderOptions(
        { ...REOPENED, agent: 'claude', providerStarting: true },
        mutateWith(async () => new Promise(() => {})).mutate
      )
      await waitFor(() => expect(currentValue(result.current.optionSnapshot, 'model')).toBe('opus'))
      act(() => {
        void result.current.setStructuredOption('effort', 'low')
      })
      expect(currentValue(result.current.optionSnapshot, 'effort')).toBe('low')
      act(() => {
        void result.current.setStructuredOption('model', 'sonnet')
      })
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('sonnet')
      expect(currentValue(result.current.optionSnapshot, 'effort')).toBe('low')
      unmount()
    })

    // A started host knows the model selected by Claude settings/environment.
    const CLAUDE_STARTED = {
      models: [
        { id: 'opus[1m]', label: 'Opus (1M context)', isDefault: true, efforts: [] },
        { id: 'haiku', label: 'Haiku', isDefault: false, efforts: [] }
      ],
      current: { model: 'haiku' }
    }
    const optionReads = (): number =>
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.options').length

    it('shows the model a new chat will run once its provider starts, not a seed default', async () => {
      answer({ options: () => Promise.resolve(CLAUDE_STARTED) })
      const starting = { ...ATTACHED, agent: 'claude' as const, providerStarting: true }
      const { result, rerender, unmount } = renderOptions(
        starting,
        mutateWith(async () => null).mutate
      )
      await tick()
      expect(optionReads()).toBe(0)
      expect(currentValue(result.current.optionSnapshot, 'model')).toBeNull()

      rerender({ ...starting, providerStarting: false })
      await waitFor(() =>
        expect(currentValue(result.current.optionSnapshot, 'model')).toBe('haiku')
      )
      expect(descriptor(result.current.optionSnapshot, 'model')?.valueSource).toBe('dispatched')
      expect(optionReads()).toBe(1)
      unmount()
    })

    it('still reads a reopened chat while it starts, whose host holds the model it ran', async () => {
      answer({ options: () => Promise.resolve(CLAUDE_STARTED) })
      const starting = { ...REOPENED, agent: 'claude' as const, providerStarting: true }
      const { result, rerender, unmount } = renderOptions(
        starting,
        mutateWith(async () => null).mutate
      )
      await waitFor(() =>
        expect(currentValue(result.current.optionSnapshot, 'model')).toBe('haiku')
      )

      rerender({ ...starting, providerStarting: false })
      await waitFor(() => expect(optionReads()).toBe(2))
      unmount()
    })
  })

  describe("a paired server's new chat", () => {
    beforeEach(() => replaceRuntimeEnvironmentRevisions([{ id: 'server-1', createdAt: 1 }]))
    it("shows the server's seed once its list answers and remembers a pick on the server under its model", async () => {
      answer({ modelCatalog: () => Promise.resolve(SAVED_LIST) })
      mocks.hold.mockResolvedValue({ kind: 'accepted', options: { effort: 'high' } })
      const { result, unmount } = renderOptions(
        { ...PROVISIONAL, paired: true, launchSeedOptions: SEED },
        mutateWith(async () => null).mutate
      )
      await waitFor(() =>
        expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-5.5')
      )
      expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(true)

      await act(async () => {
        await result.current.setStructuredOption('effort', 'high')
      })
      await waitFor(() =>
        expect(mocks.enqueue).toHaveBeenCalledWith(
          PAIRED_TARGET,
          {
            type: 'apply-picks',
            agent: 'codex',
            picks: [{ modelId: 'gpt-5.5', optionId: 'effort', value: 'high' }]
          },
          { expectedEnvironmentPairingRevision: 1 }
        )
      )
      unmount()
    })

    it('shows the CLI default and takes picks when the server saved no model', async () => {
      answer({ modelCatalog: () => Promise.resolve(HOST_CATALOG) })
      mocks.hold.mockResolvedValue({ kind: 'accepted', options: { model: 'gpt-hosted' } })
      const { result, unmount } = renderOptions(
        { ...PROVISIONAL, paired: true },
        mutateWith(async () => null).mutate
      )
      await waitFor(() =>
        expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-hosted')
      )
      expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(true)

      await act(async () => {
        await result.current.setStructuredOption('model', 'gpt-hosted')
      })
      expect(mocks.hold).toHaveBeenCalledWith('session-1', 'model', 'gpt-hosted', expect.anything())
      unmount()
    })

    it('takes picks again once the server reports its model', async () => {
      answer({ options: () => Promise.resolve(LIVE_OPTIONS) })
      const { calls, mutate } = mutateWith(async () => ({ options: { model: 'gpt-5.6-luna' } }))
      const { result, unmount } = renderOptions({ ...ATTACHED, paired: true }, mutate)
      await waitFor(() =>
        expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-5.5')
      )

      await act(async () => {
        await result.current.setStructuredOption('model', 'gpt-5.6-luna')
      })
      expect(setOptionCalls(calls)).toHaveLength(1)
      unmount()
    })
  })

  const efforts = ['low', 'high'].map((value) => ({ value, label: value }))

  describe('a new Claude chat in a fresh Claude home', () => {
    // A fresh home has learned no configured model, so the listing doesn't name what runs.
    const FRESH_LIST = {
      origin: 'probe',
      fetchedAt: 1,
      listingNamesConfiguredModel: false,
      models: [
        { id: 'opus', label: 'Opus', isDefault: true, defaultEffort: 'high', efforts },
        { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts }
      ]
    }
    const AT_REST = {
      models: FRESH_LIST.models,
      listedModelIds: ['opus', 'sonnet'],
      current: { model: 'opus', effort: 'high', defaulted: ['model', 'effort'] }
    }

    it.each(['list', 'answer'])(
      'names Opus High and pins both on the first send, the %s landing first',
      async (first) => {
        let landList = (): void => {}
        let landAnswer = (): void => {}
        const list = new Promise((resolve) => (landList = () => resolve(FRESH_LIST)))
        const atRest = new Promise((resolve) => (landAnswer = () => resolve(AT_REST)))
        answer({ modelCatalog: () => list, options: () => atRest })
        const { result, unmount } = renderOptions(
          { ...ATTACHED, agent: 'claude' },
          mutateWith(async () => null).mutate
        )
        for (const land of first === 'list' ? [landList, landAnswer] : [landAnswer, landList]) {
          await act(async () => {
            land()
            await tick()
          })
        }
        await waitFor(() =>
          expect(currentValue(result.current.optionSnapshot, 'model')).toBe('opus')
        )
        const { optionStateRef, optionView } = result.current.sendSource
        expect(
          structuredAgentSessionSendSelection(optionView(optionStateRef.current, undefined))
        ).toEqual({ model: 'opus', effort: 'high' })
        unmount()
      }
    )
  })

  it.each([
    // Claude replies only with values Orca set; retained effort is omitted.
    {
      agent: 'claude' as const,
      tiers: [[], []],
      current: { model: 'opus', effort: 'high' },
      reply: {},
      shown: ['effort', 'high']
    },
    // Codex immediately reports Standard when the new model lacks the selected tier.
    {
      agent: 'codex' as const,
      tiers: [[{ value: 'priority', label: 'Fast' }], [{ value: 'flex', label: 'Flex' }]],
      current: { model: 'opus', serviceTier: 'priority' },
      reply: { serviceTier: 'default' },
      shown: ['serviceTier', 'default']
    },
    // Unlisted configured Flex remains effective and must stay shown as held.
    {
      agent: 'codex' as const,
      tiers: [[{ value: 'priority', label: 'Fast' }], [{ value: 'priority', label: 'Fast' }]],
      current: { model: 'opus', serviceTier: 'flex' },
      reply: {},
      shown: ['serviceTier', 'flex']
    }
  ])(
    'a $agent model pick shows what its reply names and keeps what it leaves out, $shown',
    async (pick) => {
      const live = {
        models: ['opus', 'second'].map((id, index) => ({
          id,
          label: id,
          isDefault: index === 0,
          efforts,
          serviceTiers: pick.tiers[index]
        })),
        current: { ...pick.current, confirmed: ['model'] }
      }
      let reads = 0
      // The authoritative read supplies model-dependent normalization; replies settle operations.
      answer({
        options: async () =>
          ++reads === 1
            ? live
            : { ...live, current: { ...live.current, model: 'second', ...pick.reply } }
      })
      const { mutate } = mutateWith(async () => ({
        key: 'model',
        value: 'second',
        options: { model: 'second', ...pick.reply }
      }))
      const { result, unmount } = renderOptions({ ...REOPENED, agent: pick.agent }, mutate)
      await waitFor(() => expect(currentValue(result.current.optionSnapshot, 'model')).toBe('opus'))
      await act(async () => {
        await result.current.setStructuredOption('model', 'second')
      })
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('second')
      expect(currentValue(result.current.optionSnapshot, pick.shown[0]!)).toBe(pick.shown[1])
      unmount()
    }
  )

  it.each([true, false, undefined])(
    "reports the session's own image answer, %s, once its options read lands",
    async (acceptsImages) => {
      answer({
        options: () =>
          Promise.resolve(
            acceptsImages === undefined ? LIVE_OPTIONS : { ...LIVE_OPTIONS, acceptsImages }
          )
      })
      const { result, unmount } = renderOptions(REOPENED, mutateWith(async () => null).mutate)
      expect(result.current.acceptsImages).toBeUndefined()
      await waitFor(() =>
        expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-5.5')
      )
      expect(result.current.acceptsImages).toBe(acceptsImages)
      unmount()
    }
  )
})

import type {
  PiRefreshFixtureModule,
  PiRefreshMount
} from '../../../../shared/structured-agent-session-option-refresh.test-fixture-contract'
const { piOptionRefreshContract } = await vi.importActual<PiRefreshFixtureModule>(
  '../../../../main/native-chat/agent-session-wire/structured-agent-session-option-refresh.test-fixture'
)

describe('Pi catalog refresh completion', () => {
  beforeEach(() => {
    replaceRuntimeEnvironmentRevisions([{ id: 'server-1', createdAt: 1 }])
    mocks.sendSelection = true
    mocks.call.mockReset()
    mocks.enqueue.mockReset()
    mocks.hold.mockReset()
    resetHostModelCatalogSnapshotsForTests()
  })

  const hosts = new Map<string, Parameters<PiRefreshMount>[0]>()
  piOptionRefreshContract(
    async (host) => {
      forgetStructuredSessionSelection(host.record.sessionId)
      hosts.set(host.record.sessionId, host)
      mocks.call.mockImplementation(
        (
          _target: unknown,
          method: string,
          params: {
            sessionId?: string
            envelope?: { sessionId?: string }
            key?: string
            value?: string
          }
        ) => {
          const id = params?.sessionId ?? params?.envelope?.sessionId
          const current = id ? hosts.get(id) : undefined
          if (method === 'agentSession.options' && current) {
            return current.options()
          }
          if (method === 'agentSession.modelCatalog' && current) {
            return current.catalog()
          }
          if (
            method === 'agentSession.setOption' &&
            current &&
            params.key === 'effort' &&
            typeof params.value === 'string'
          ) {
            return current.acceptEffort(params.value).then((value) => ({ ok: true, value }))
          }
          return new Promise(() => {})
        }
      )
      const { mutate } = mutateWith(async (_method, _fingerprint, fields) => {
        if (
          typeof fields !== 'object' ||
          fields === null ||
          !('value' in fields) ||
          typeof fields.value !== 'string'
        ) {
          throw new Error('missing effort')
        }
        return host.acceptEffort(fields.value)
      })
      const props: RenderProps = { ...REOPENED, agent: 'pi', sessionId: host.record.sessionId }
      const harness = renderOptions(props, mutate)
      await act(async () => {
        await Promise.resolve()
      })
      return {
        snapshot: () => harness.result.current.optionSnapshot,
        capture: () => harness.result.current.capture().selection,
        demand: () => harness.result.current.optionSurface.demandModelCatalog?.(),
        pick: (value) => harness.result.current.setStructuredOption('effort', value),
        replace: async (fence, otherHost) => {
          await act(async () => harness.rerender({ ...props, fence, paired: otherHost }))
        },
        close: async () => {
          harness.unmount()
          hosts.delete(host.record.sessionId)
        }
      }
    },
    async (work) => {
      await act(async () => {
        work()
        await Promise.resolve()
        await Promise.resolve()
      })
    }
  )
})
