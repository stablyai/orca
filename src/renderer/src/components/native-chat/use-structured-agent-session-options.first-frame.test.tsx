// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HostCapability from '@/runtime/structured-agent-session-host-capability'

const mocks = vi.hoisted(() => ({ call: vi.fn(), coherent: false }))

vi.mock('@/runtime/structured-agent-session-host-capability', async (original) => ({
  ...(await original<typeof HostCapability>()),
  useStructuredAgentSessionHostCapability: (_target: unknown, capability: string) =>
    capability === 'agent-session.coherent-model-catalog.v1' && mocks.coherent
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() }))
}))
vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(),
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from '../../../../shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  preloadHostModelCatalogSnapshots,
  resetHostModelCatalogSnapshotsForTests
} from '@/runtime/host-model-catalog-snapshots'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const LOCAL_TARGET = { kind: 'local' } as const
const PAIRED_TARGET = { kind: 'environment', environmentId: 'server-1' } as const
const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' }
]

type Listed = Exclude<AgentSessionModelCatalogResult, { origin: 'unknown' }>

function listed(
  models: { id: string; label: string }[],
  listingNamesConfiguredModel = false
): Listed {
  return {
    origin: 'probe',
    models: models.map((model, index) => ({
      ...model,
      isDefault: index === 0,
      defaultEffort: 'high',
      efforts: EFFORTS
    })),
    fetchedAt: 1_000,
    listingNamesConfiguredModel
  }
}

const CLAUDE_LIST = listed([
  { id: 'opus[1m]', label: 'Opus (1M context)' },
  { id: 'sonnet', label: 'Sonnet' }
])
// Distinct host labels expose accidental first paints from the built-in list.
const CODEX_LIST = listed([
  { id: 'gpt-5.5', label: 'GPT-5.5 (host)' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }
])
const GROK_LIST = listed([{ id: 'grok-build', label: 'Grok Build' }], true)

type Pill = { model: string | null; label: string | null; effort: string | null; usable: boolean }

function pill(snapshot: readonly SessionOptionDescriptor[]): Pill {
  const model = snapshot.find((entry) => entry.id === 'model')
  const effort = snapshot.find((entry) => entry.id === 'effort')
  const current = model?.kind.type === 'select' ? (model.kind.currentValue ?? null) : null
  const choice =
    model?.kind.type === 'select'
      ? model.kind.choices.find((entry) => entry.value === current)
      : undefined
  return {
    model: current,
    label: choice?.label ?? null,
    effort: effort?.kind.type === 'select' ? (effort.kind.currentValue ?? null) : null,
    usable: Boolean(model?.settable)
  }
}

const PLACEHOLDER: Pill = { model: null, label: null, effort: null, usable: false }

function renderNewChat(args: {
  agent: AgentType
  target?: RuntimeClientTarget
  seedOptions?: Record<string, string>
  explicitOptions?: Record<string, string>
  sessionId?: string
}) {
  const frames: Pill[] = []
  const view = renderHook(() => {
    const options = useStructuredAgentSessionOptions({
      agent: args.agent,
      sessionId: args.sessionId ?? 'session-1',
      target: args.target ?? LOCAL_TARGET,
      transportEnabled: false,
      isVisible: true,
      providerVisible: false,
      fence: null,
      turnId: null,
      unloadedTurnRevisions: undefined,
      mutate: vi.fn(),
      launch: {
        kind: 'new',
        heldOptions: {},
        worktree: 'id:wt-1',
        ...(args.explicitOptions ? { explicitOptions: args.explicitOptions } : {}),
        ...(args.seedOptions ? { seedOptions: args.seedOptions } : {})
      }
    })
    frames.push(pill(options.optionSnapshot))
    return options
  })
  return { frames, ...view }
}

function catalogAnswers(...answers: (() => Promise<unknown>)[]): void {
  let reads = 0
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.modelCatalog'
      ? (answers[Math.min(reads++, answers.length - 1)] ?? (() => new Promise(() => {})))()
      : new Promise(() => {})
  )
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}

describe('a new chat picker’s first frame', () => {
  afterEach(() => vi.useRealTimers())
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.coherent = false
    resetHostModelCatalogSnapshotsForTests()
  })

  it('shows the unlisted action model rather than a saved or listed replacement on every pending frame', async () => {
    catalogAnswers(() => Promise.resolve(CLAUDE_LIST))
    await preloadHostModelCatalogSnapshots(LOCAL_TARGET, ['claude'])
    const view = renderNewChat({
      agent: 'claude',
      seedOptions: { model: 'opus[1m]', effort: 'high' },
      explicitOptions: { model: 'unlisted-action' }
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(
      view.frames.every((frame) => frame.model === 'unlisted-action' && frame.effort !== 'high')
    ).toBe(true)
    view.unmount()
  })

  it('names a saved Claude pick and its effort from the saved list on the first frame', async () => {
    catalogAnswers(() => Promise.resolve(CLAUDE_LIST))
    await preloadHostModelCatalogSnapshots(LOCAL_TARGET, ['claude'])
    const { frames, unmount } = renderNewChat({
      agent: 'claude',
      seedOptions: { model: 'opus[1m]', effort: 'high' }
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    const final = { model: 'opus[1m]', label: 'Opus (1M context)', effort: 'high', usable: true }
    expect(frames[0]).toEqual(final)
    expect(frames.every((frame) => JSON.stringify(frame) === JSON.stringify(final))).toBe(true)
    unmount()
  })

  it('uses installed controls and keeps saved values through a quiet refresh', async () => {
    mocks.coherent = true
    const child: AgentSessionOptionsResult = {
      models: [{ id: 'A', label: 'Old child A', isDefault: false, efforts: EFFORTS }],
      current: { model: 'A', effort: 'low', permissionMode: 'ask', defaulted: [] }
    }
    let raw: Listed = listed([{ id: 'A', label: 'Installed A' }])
    const next = deferred<AgentSessionModelCatalogResult>()
    mocks.call.mockImplementation(
      (_target: unknown, method: string, params: { waitForListing?: boolean }) =>
        method === 'agentSession.options'
          ? Promise.resolve(child)
          : method === 'agentSession.modelCatalog'
            ? params.waitForListing
              ? next.promise
              : Promise.resolve(raw)
            : new Promise(() => {})
    )
    const view = renderHook(() =>
      useStructuredAgentSessionOptions({
        agent: 'codex',
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        transportEnabled: true,
        isVisible: true,
        providerVisible: true,
        fence: 1,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate: vi.fn()
      })
    )
    const effort = () => view.result.current.optionSnapshot.find((row) => row.id === 'effort')
    await waitFor(() => expect(effort()?.settable).toBe(true))
    raw = { ...raw, listingInProgress: true }
    await act(async () => view.result.current.optionSurface.demandModelCatalog?.())
    expect(effort()?.settable).toBe(false)
    await act(async () =>
      next.resolve({
        ...raw,
        listingInProgress: undefined,
        models: raw.models.map((row) => ({ ...row, efforts: [EFFORTS[1]!] }))
      })
    )
    await waitFor(() =>
      expect(effort()).toMatchObject({
        settable: true,
        kind: { currentValue: 'low', choices: expect.arrayContaining([EFFORTS[1]]) }
      })
    )
    expect(view.result.current.sendSource.optionStateRef.current.record.values).toMatchObject({
      model: { value: 'A' },
      effort: { value: 'low' }
    })
    view.unmount()
  })

  it('codex: the saved list names a saved pick and its effort on the first frame', async () => {
    catalogAnswers(() => Promise.resolve(CODEX_LIST))
    await preloadHostModelCatalogSnapshots(LOCAL_TARGET, ['codex'])
    const { frames, unmount } = renderNewChat({
      agent: 'codex',
      seedOptions: { model: 'gpt-5.5', effort: 'low' }
    })
    expect(frames[0]).toEqual({
      model: 'gpt-5.5',
      label: 'GPT-5.5 (host)',
      effort: 'low',
      usable: true
    })
    unmount()
  })

  it('grok: the default the host names for a workspace is named on that workspace’s next chat', async () => {
    catalogAnswers(() => Promise.resolve(GROK_LIST))
    const first = renderNewChat({ agent: 'grok' })
    await waitFor(() => expect(first.frames.at(-1)?.label).toBe('Grok Build'))
    first.unmount()
    const next = renderNewChat({ agent: 'grok', sessionId: 'session-2' })
    expect(next.frames[0]).toEqual({
      model: 'grok-build',
      label: 'Grok Build',
      effort: 'high',
      usable: true
    })
    next.unmount()
  })

  it('a chat naming no model waits for its own workspace’s answer: its config may replace the default', async () => {
    catalogAnswers(() => Promise.resolve(GROK_LIST))
    await preloadHostModelCatalogSnapshots(LOCAL_TARGET, ['grok'])
    const { frames, unmount } = renderNewChat({ agent: 'grok' })
    expect(frames[0]).toEqual(PLACEHOLDER)
    await waitFor(() => expect(frames.at(-1)?.label).toBe('Grok Build'))
    expect(frames.filter((frame) => frame.model === null).every((f) => !f.usable)).toBe(true)
    unmount()
  })

  it.each(['claude', 'codex', 'grok'] as const)(
    '%s: a cold account shows the quiet placeholder until the host answers, then the list once',
    async (agent) => {
      const answer = deferred<AgentSessionModelCatalogResult>()
      catalogAnswers(() => answer.promise)
      const list = agent === 'claude' ? CLAUDE_LIST : agent === 'codex' ? CODEX_LIST : GROK_LIST
      const first = list.models[0]!
      const { frames, unmount } = renderNewChat({ agent, seedOptions: { model: first.id } })
      expect(frames[0]).toEqual(PLACEHOLDER)
      answer.resolve(list)
      await waitFor(() => expect(frames.at(-1)?.usable).toBe(true))
      const named = frames.filter((frame) => frame.model !== null)
      expect(new Set(named.map((frame) => frame.label))).toEqual(new Set([first.label]))
      const beforeNamed = frames.slice(0, frames.indexOf(named[0]!))
      expect(beforeNamed).toEqual(beforeNamed.map(() => PLACEHOLDER))
      unmount()
    }
  )

  it('with nothing saved, the built-in list is usable, naming nothing, until the listing lands', async () => {
    const listing = deferred<AgentSessionModelCatalogResult>()
    catalogAnswers(
      () => Promise.resolve({ origin: 'unknown', listingInProgress: true }),
      () => listing.promise
    )
    const { frames, unmount } = renderNewChat({ agent: 'codex', seedOptions: { model: 'gpt-5.5' } })
    expect(frames[0]).toEqual(PLACEHOLDER)
    await waitFor(() => expect(frames.at(-1)).toEqual({ ...PLACEHOLDER, usable: true }))
    listing.resolve(CODEX_LIST)
    await waitFor(() => expect(frames.at(-1)?.label).toBe('GPT-5.5 (host)'))
    expect(frames.some((frame) => frame.model !== null && frame.label !== 'GPT-5.5 (host)')).toBe(
      false
    )
    unmount()
  })

  it('never paints a saved pick the host list does not name', async () => {
    catalogAnswers(() => Promise.resolve(CODEX_LIST))
    await preloadHostModelCatalogSnapshots(LOCAL_TARGET, ['codex'])
    const { frames, unmount } = renderNewChat({
      agent: 'codex',
      seedOptions: { model: 'gpt-retired' }
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(frames.every((frame) => frame.model === null && !frame.usable)).toBe(true)
    unmount()
  })

  it("uses a paired server's own saved list, kept from its last new chat", async () => {
    catalogAnswers(() => Promise.resolve(CODEX_LIST))
    const first = renderNewChat({
      agent: 'codex',
      target: PAIRED_TARGET,
      seedOptions: { model: 'gpt-5.5' }
    })
    await waitFor(() => expect(first.frames.at(-1)?.label).toBe('GPT-5.5 (host)'))
    first.unmount()

    const second = renderNewChat({
      agent: 'codex',
      target: PAIRED_TARGET,
      seedOptions: { model: 'gpt-6.1-sol' },
      sessionId: 'session-2'
    })
    expect(second.frames[0]).toMatchObject({ label: 'GPT-6.1 Sol', usable: true })
    second.unmount()
    // A paired host’s cache must never name a model for the unanswered local host.
    const local = renderNewChat({ agent: 'codex', seedOptions: { model: 'gpt-5.5' } })
    expect(local.frames[0]).toEqual(PLACEHOLDER)
    local.unmount()
  })
})
