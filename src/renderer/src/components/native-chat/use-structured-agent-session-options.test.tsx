// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  enqueue: vi.fn(),
  hold: vi.fn<(sessionId: string, id: string, encoded: string) => Promise<unknown> | null>(),
  toastError: vi.fn<(message: string) => void>()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.enqueue
}))

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: mocks.hold,
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const LOCAL_TARGET = { kind: 'local' } as const

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
}

// A new chat: create has not published, so there is no fence and no live read.
const PROVISIONAL: RenderProps = { transportEnabled: false, fence: null, launch: 'new' }
// The receipt lands first; attach delivers the fence on a later render.
const PUBLISHED_UNATTACHED: RenderProps = { transportEnabled: true, fence: null, launch: 'new' }
const ATTACHED: RenderProps = { transportEnabled: true, fence: 1, launch: 'new' }
// A chat this view did not launch (reopened), attached before its first live read.
const REOPENED: RenderProps = { transportEnabled: true, fence: 1 }

function renderOptions(initial: RenderProps, mutate: StructuredAgentSessionMutate) {
  return renderHook(
    (props: RenderProps) =>
      useStructuredAgentSessionOptions({
        agent: props.agent ?? 'codex',
        sessionId: 'session-1',
        target: LOCAL_TARGET,
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

const SEED = { model: 'gpt-5.5' }
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('useStructuredAgentSessionOptions', () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.enqueue.mockReset()
    mocks.hold.mockReset()
    mocks.toastError.mockReset()
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
    // A read can start a background listing process; restored hidden tabs must not at startup.
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
    // Nothing would carry the pick: no launch holds it and there is no fence to send it under.
    expect(descriptor(result.current.optionSnapshot, 'model')).toMatchObject({
      settable: false,
      disabledReason: 'available-after-session-start'
    })
    rerender({ ...unattached, fence: 1 })
    expect(descriptor(result.current.optionSnapshot, 'model')?.settable).toBe(true)
    unmount()
  })

  it('treats method_not_found and forbidden as an absent surface and keeps the seed', async () => {
    for (const code of ['method_not_found', 'forbidden']) {
      answer({ modelCatalog: () => Promise.reject(new FakeRpcCallError(code)) })
      const { result, unmount } = renderOptions(
        { ...PROVISIONAL, launchSeedOptions: SEED },
        mutateWith(async () => null).mutate
      )
      await tick()
      expect(modelChoiceCount(result.current.optionSnapshot)).toBeGreaterThan(0)
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-5.5')
      unmount()
    }
  })

  it('lets the live options result win over a later host catalog answer', async () => {
    let settleCatalog!: (value: unknown) => void
    answer({
      options: () => Promise.resolve(LIVE_OPTIONS),
      modelCatalog: () => new Promise((resolve) => (settleCatalog = resolve))
    })
    const { result, unmount } = renderOptions(ATTACHED, mutateWith(async () => null).mutate)
    await waitFor(() =>
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-5.5')
    )
    settleCatalog(HOST_CATALOG)
    await tick()
    const model = descriptor(result.current.optionSnapshot, 'model')
    expect(model?.kind.type === 'select' ? model.kind.currentValue : null).toBe('gpt-5.5')
    expect(
      model?.kind.type === 'select' &&
        model.kind.choices.some((choice) => choice.value === 'gpt-hosted')
    ).toBe(false)
    unmount()
  })

  describe('while the launch is provisional', () => {
    it('renders the launch seed and hands a pick to the launch without any RPC', async () => {
      answer({})
      mocks.hold.mockReturnValue(new Promise(() => {}))
      const { mutate, calls } = mutateWith(async () => null)
      const { result, rerender, unmount } = renderOptions(
        { ...PROVISIONAL, launchSeedOptions: SEED },
        mutate
      )
      expect(modelChoiceCount(result.current.optionSnapshot)).toBeGreaterThan(0)
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-5.5')

      let accepted = false
      await act(async () => {
        accepted = await result.current.setStructuredOption('model', 'gpt-5.6-luna')
      })
      expect(accepted).toBe(true)
      expect(mocks.hold).toHaveBeenCalledWith('session-1', 'model', 'gpt-5.6-luna')
      // The launch owns the pick; the view renders what it holds.
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
      // A resumed chat names no listed default, so its read asks nothing of the workspace.
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
      // Nothing to withhold, so the read names no workspace for the host to inspect.
      expect(mocks.call).toHaveBeenCalledWith(LOCAL_TARGET, 'agentSession.modelCatalog', {
        agent: 'claude',
        sessionId: 'session-1'
      })
      rerender({ ...claude, launchSeedOptions: SEED })
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-5.5')
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
      rerender({ ...resumed, launchSeedOptions: SEED })
      expect(currentValue(result.current.optionSnapshot, 'model')).toBe('gpt-5.5')
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
      answer({})
      mocks.hold.mockResolvedValue({ kind: 'accepted', options: { model: 'gpt-5.6-luna' } })
      const { result, unmount } = renderOptions(
        { ...PROVISIONAL, launchSeedOptions: SEED },
        mutateWith(async () => null).mutate
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
      answer({})
      mocks.hold.mockResolvedValue({
        kind: 'refused',
        failure: { kind: 'refused', code: 'agent_session_operation_capacity' }
      })
      const { result, unmount } = renderOptions(
        { ...PROVISIONAL, launchSeedOptions: SEED },
        mutateWith(async () => null).mutate
      )
      await act(async () => {
        await result.current.setStructuredOption('model', 'gpt-5.6-luna')
      })
      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith(
          "Orca is handling too many requests for this chat. The setting wasn't changed. Choose it again."
        )
      )
      expect(mocks.enqueue).not.toHaveBeenCalled()
      unmount()
    })

    it('sends a pick made once the launch has published through the session, not the launch', async () => {
      answer({})
      mocks.hold.mockReturnValue(null)
      const { mutate, calls } = mutateWith(async () => null)
      const { result, rerender, unmount } = renderOptions(
        { ...PUBLISHED_UNATTACHED, launchSeedOptions: SEED },
        mutate
      )
      let accepted = true
      await act(async () => {
        accepted = await result.current.setStructuredOption('model', 'gpt-5.6-luna')
      })
      // Published, not yet attached: nothing holds it and there is no fence to send it on.
      expect(accepted).toBe(false)
      expect(calls).not.toHaveBeenCalled()

      rerender({ ...ATTACHED, launchSeedOptions: SEED })
      await act(async () => {
        await result.current.setStructuredOption('model', 'gpt-5.6-luna')
      })
      expect(setOptionCalls(calls)).toEqual([{ key: 'model', value: 'gpt-5.6-luna' }])
      expect(mocks.hold).toHaveBeenCalledTimes(1)
      unmount()
    })
  })

  describe('before the provider starts', () => {
    // What a started Claude host reports: the model its settings or env make Claude run.
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
      // The host has not read what Claude will run yet, so its answer would be a guess.
      expect(optionReads()).toBe(0)
      expect(currentValue(result.current.optionSnapshot, 'model')).toBeNull()

      rerender({ ...starting, providerStarting: false })
      await waitFor(() =>
        expect(currentValue(result.current.optionSnapshot, 'model')).toBe('haiku')
      )
      // Unconfirmed until a turn reports it.
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
      // Re-read once started: only then has the host read what the provider will run.
      await waitFor(() => expect(optionReads()).toBe(2))
      unmount()
    })
  })
})
