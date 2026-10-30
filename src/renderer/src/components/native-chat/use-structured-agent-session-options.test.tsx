// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  enqueue: vi.fn(),
  hold: vi.fn<
    (sessionId: string, id: string, encoded: string, picker?: unknown) => Promise<unknown> | null
  >(),
  toastError: vi.fn<(message: string) => void>()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() })),
  callStructuredAgentSession: mocks.call
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.enqueue
}))

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: mocks.hold,
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import { structuredAgentSessionSendSelection } from '../../../../shared/structured-agent-session-option-view'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'

const LOCAL_TARGET = { kind: 'local' } as const
const PAIRED_TARGET = { kind: 'environment', environmentId: 'server-1' } as const

class FakeRpcCallError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

type Answers = {
  options?: () => Promise<unknown>
  modelCatalog?: () => Promise<unknown>
}

function answer(answers: Answers): void {
  mocks.call.mockImplementation((_target: unknown, method: string) => {
    if (method === 'agentSession.options' && answers.options) {
      return answers.options()
    }
    if (method === 'agentSession.modelCatalog' && answers.modelCatalog) {
      return answers.modelCatalog()
    }
    return new Promise(() => {})
  })
}

type MutateCall = (...args: unknown[]) => Promise<unknown>

function mutateWith(reply: MutateCall): {
  mutate: StructuredAgentSessionMutate
  calls: ReturnType<typeof vi.fn<MutateCall>>
} {
  const calls = vi.fn<MutateCall>(reply)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each reply is null or the AgentSessionOptionResult shape the hook reads.
  return { mutate: calls as unknown as StructuredAgentSessionMutate, calls }
}

type RenderProps = {
  transportEnabled: boolean
  fence: number | null
  turnId?: string | null
  launch?: 'new' | 'resume'
  hidden?: boolean
  launchSeedOptions?: Record<string, string>
  heldOptions?: Record<string, string>
  worktree?: string
  agent?: 'claude' | 'codex'
  providerStarting?: boolean
  paired?: boolean
}

const PROVISIONAL: RenderProps = { transportEnabled: false, fence: null, launch: 'new' }
// The receipt lands first; attach delivers the fence on a later render.
const PUBLISHED_UNATTACHED: RenderProps = { transportEnabled: true, fence: null, launch: 'new' }
const ATTACHED: RenderProps = { transportEnabled: true, fence: 1, launch: 'new' }
const REOPENED: RenderProps = { transportEnabled: true, fence: 1 }

function renderOptions(initial: RenderProps, mutate: StructuredAgentSessionMutate) {
  return renderHook(
    (props: RenderProps) =>
      useStructuredAgentSessionOptions({
        agent: props.agent ?? 'codex',
        sessionId: 'session-1',
        target: props.paired ? PAIRED_TARGET : LOCAL_TARGET,
        transportEnabled: props.transportEnabled,
        isVisible: !props.hidden,
        providerVisible: props.transportEnabled && !props.hidden,
        ...(props.providerStarting ? { providerStarting: true } : {}),
        fence: props.fence,
        turnId: props.turnId ?? null,
        unloadedTurnRevisions: undefined,
        mutate,
        ...(props.launch
          ? {
              launch: {
                kind: props.launch,
                ...(props.launchSeedOptions ? { seedOptions: props.launchSeedOptions } : {}),
                heldOptions: props.heldOptions ?? {},
                ...(props.worktree ? { worktree: props.worktree } : {})
              }
            }
          : {})
      }),
    { initialProps: initial }
  )
}

function descriptor(snapshot: readonly SessionOptionDescriptor[], id: string) {
  return snapshot.find((entry) => entry.id === id)
}

function currentValue(snapshot: readonly SessionOptionDescriptor[], id: string) {
  const entry = descriptor(snapshot, id)
  return entry?.kind.type === 'select' ? (entry.kind.currentValue ?? null) : null
}

function modelChoiceCount(snapshot: readonly SessionOptionDescriptor[]): number {
  const model = descriptor(snapshot, 'model')
  return model?.kind.type === 'select' ? model.kind.choices.length : 0
}

function setOptionCalls(calls: ReturnType<typeof vi.fn<MutateCall>>): unknown[] {
  return calls.mock.calls
    .filter(([method]) => method === 'agentSession.setOption')
    .map(([, , fields]) => fields)
}

const HOST_CATALOG = {
  origin: 'live-session',
  models: [
    {
      id: 'gpt-hosted',
      label: 'GPT Hosted',
      isDefault: true,
      efforts: [{ value: 'high', label: 'High' }]
    }
  ],
  fetchedAt: 1_000
}

const LIVE_OPTIONS = {
  models: [
    { id: 'gpt-5.5', label: 'GPT-5.5', isDefault: true, efforts: [] },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: [] }
  ],
  current: { model: 'gpt-5.5', confirmed: ['model'] }
}

const SAVED_LIST = {
  origin: 'probe',
  models: [
    {
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      isDefault: true,
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: [] }
  ],
  fetchedAt: 1_000
}

const SEED = { model: 'gpt-5.5' }
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('useStructuredAgentSessionOptions', () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.enqueue.mockReset()
    mocks.hold.mockReset()
    mocks.toastError.mockReset()
    resetHostModelCatalogSnapshotsForTests()
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
      expect(mocks.hold).toHaveBeenCalledWith('session-1', 'model', 'gpt-5.6-luna')
      rerender({ ...PROVISIONAL, launchSeedOptions: SEED, heldOptions: { model: 'gpt-5.6-luna' } })
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
        expect(mocks.enqueue).toHaveBeenCalledWith(PAIRED_TARGET, {
          type: 'apply-picks',
          agent: 'codex',
          picks: [{ modelId: 'gpt-5.5', optionId: 'effort', value: 'high' }]
        })
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
      expect(mocks.hold).toHaveBeenCalledWith('session-1', 'model', 'gpt-hosted')
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
          structuredAgentSessionSendSelection(optionView(optionStateRef.current, undefined, {}))
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
      // The read after the pick never lands, so only the reply speaks.
      answer({ options: () => (++reads === 1 ? Promise.resolve(live) : new Promise(() => {})) })
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
