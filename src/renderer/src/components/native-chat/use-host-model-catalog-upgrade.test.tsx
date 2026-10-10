// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(() => Promise.resolve({ kind: 'held' })),
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'

const PAIRED_TARGET = { kind: 'environment', environmentId: 'server-1' } as const
const UNKNOWN = { origin: 'unknown' }
const LISTING = { origin: 'unknown', listingInProgress: true }
const HOST_CATALOG = {
  origin: 'probe',
  models: [
    { id: 'gpt-hosted', label: 'GPT Hosted', isDefault: true, efforts: [] },
    // The launch seed's model, so the saved pick is one the host list names.
    { id: 'gpt-5.5', label: 'GPT-5.5', efforts: [] }
  ],
  fetchedAt: 1_000
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no test here sends a pick over a fence, so mutate is never called.
const mutate = vi.fn(async () => null) as unknown as StructuredAgentSessionMutate

type Props = { hidden?: boolean; attached?: boolean; sessionId?: string }

// A chat's waiting read outlives its mounts, so each test gets its own chat.
let sessionId = ''
let sessionCount = 0

function renderOptions(initial: Props = {}) {
  return renderHook(
    (props: Props) =>
      useStructuredAgentSessionOptions({
        agent: 'codex',
        sessionId: props.sessionId ?? sessionId,
        target: PAIRED_TARGET,
        transportEnabled: props.attached === true,
        isVisible: !props.hidden,
        providerVisible: props.attached === true && !props.hidden,
        fence: props.attached ? 1 : null,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate,
        launch: { kind: 'new', seedOptions: { model: 'gpt-5.5' }, heldOptions: {} }
      }),
    { initialProps: initial }
  )
}

type Deferred = {
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Each catalog read takes the next answer; `options` reads never settle unless given. */
function answerCatalog(answers: (() => Promise<unknown>)[]): void {
  let index = 0
  mocks.call.mockImplementation((_target: unknown, method: string) => {
    if (method === 'agentSession.modelCatalog') {
      const next = answers[index]
      index += 1
      return next ? next() : new Promise(() => {})
    }
    return new Promise(() => {})
  })
}

function catalogReads(): unknown[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.modelCatalog')
    .map(([, , params]) => params)
}

/** The picker opens and takes a pick: what a usable first frame means. */
function usable(snapshot: readonly SessionOptionDescriptor[]): boolean {
  return model(snapshot).settable && modelChoices(snapshot).length > 0
}

function model(snapshot: readonly SessionOptionDescriptor[]): SessionOptionDescriptor {
  return snapshot.find((entry) => entry.id === 'model')!
}

function modelChoices(snapshot: readonly SessionOptionDescriptor[]): string[] {
  const descriptor = model(snapshot)
  return descriptor.kind.type === 'select' ? descriptor.kind.choices.map((c) => c.value) : []
}

const flush = (): Promise<void> => act(async () => {})

describe('host model catalog read', () => {
  beforeEach(() => {
    mocks.call.mockReset()
    resetHostModelCatalogSnapshotsForTests()
    sessionCount += 1
    sessionId = `session-${sessionCount}`
  })

  it('reads a warm catalog once, showing the quiet placeholder only until it answers', async () => {
    const first = deferred()
    answerCatalog([() => first.promise])
    const { result, unmount } = renderOptions()
    await flush()
    // No built-in label the host's list could replace.
    expect(modelChoices(result.current.optionSnapshot)).toEqual([])
    expect(model(result.current.optionSnapshot).settable).toBe(false)
    first.resolve(HOST_CATALOG)
    await flush()
    expect(catalogReads()).toEqual([{ agent: 'codex', sessionId }])
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')
    const named = model(result.current.optionSnapshot)
    expect(named.kind.type === 'select' ? named.kind.currentValue : null).toBe('gpt-5.5')
    expect(usable(result.current.optionSnapshot)).toBe(true)
    unmount()
  })

  it('a new Codex chat on a cold catalog shows a usable unnamed built-in list, then the listing', async () => {
    const waited = deferred()
    answerCatalog([() => Promise.resolve(LISTING), () => waited.promise])
    const { result, unmount } = renderOptions()
    await flush()
    expect(catalogReads()).toEqual([
      { agent: 'codex', sessionId },
      { agent: 'codex', sessionId, waitForListing: true }
    ])
    // Once the host says it has none: the built-in list, open to a pick, naming nothing it
    // could replace.
    const first = model(result.current.optionSnapshot)
    expect(usable(result.current.optionSnapshot)).toBe(true)
    expect(first.kind.type === 'select' ? first.kind.currentValue : null).toBeUndefined()
    expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')
    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-5.5')).toBe(true)
    })

    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')
    expect(usable(result.current.optionSnapshot)).toBe(true)
    expect(catalogReads()).toHaveLength(2)
    unmount()
  })

  it('keeps the built-in list when the waiting read fails or times out', async () => {
    for (const failure of [
      () => Promise.resolve(UNKNOWN),
      () => Promise.reject(Object.assign(new Error('timed out'), { code: 'runtime_timeout' })),
      () => Promise.reject(Object.assign(new Error('gone'), { code: 'not_connected' }))
    ]) {
      mocks.call.mockReset()
      answerCatalog([() => Promise.resolve(LISTING), failure])
      const { result, unmount } = renderOptions()
      await flush()
      expect(catalogReads()).toHaveLength(2)
      expect(usable(result.current.optionSnapshot)).toBe(true)
      expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')
      unmount()
    }
  })

  it('asks a host that reports no listing nothing more', async () => {
    answerCatalog([() => Promise.resolve(UNKNOWN)])
    const { result, unmount } = renderOptions()
    await flush()
    expect(catalogReads()).toHaveLength(1)
    expect(usable(result.current.optionSnapshot)).toBe(true)
    unmount()
  })

  it('the running provider list wins over a host listing that lands later', async () => {
    const live = deferred()
    const waited = deferred()
    answerCatalog([() => Promise.resolve(LISTING), () => waited.promise])
    const catalogAnswers = mocks.call.getMockImplementation()!
    mocks.call.mockImplementation((target: unknown, method: string, params: unknown) =>
      method === 'agentSession.options' ? live.promise : catalogAnswers(target, method, params)
    )
    const { result, unmount } = renderOptions({ attached: true })
    await flush()
    live.resolve({
      models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
      current: { model: 'gpt-live', confirmed: ['model'] }
    })
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-live')
    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')
    unmount()
  })

  it('joins the wait already in flight through attach', async () => {
    const waited = deferred()
    answerCatalog([() => Promise.resolve(LISTING), () => waited.promise])
    const { result, rerender, unmount } = renderOptions()
    await flush()
    rerender({ attached: true })
    await flush()
    expect(catalogReads()).toHaveLength(2)
    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')
    unmount()
  })

  it('joins the wait already in flight when the pane hides and shows again', async () => {
    const waited = deferred()
    answerCatalog([() => Promise.resolve(LISTING), () => waited.promise])
    const { result, rerender, unmount } = renderOptions()
    await flush()
    rerender({ hidden: true })
    await flush()
    rerender({})
    await flush()
    expect(catalogReads()).toHaveLength(2)
    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')
    unmount()
  })

  it('joins the wait already in flight when the chat mounts again', async () => {
    const waited = deferred()
    answerCatalog([() => Promise.resolve(LISTING), () => waited.promise])
    const first = renderOptions()
    await flush()
    first.unmount()
    const { result, unmount } = renderOptions()
    await flush()
    expect(catalogReads()).toHaveLength(2)
    expect(usable(result.current.optionSnapshot)).toBe(true)
    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')
    unmount()
  })

  it('answers only the chat whose host is listing', async () => {
    const waited = deferred()
    answerCatalog([
      () => Promise.resolve(LISTING),
      () => waited.promise,
      () => Promise.resolve(UNKNOWN)
    ])
    const { result, rerender, unmount } = renderOptions()
    await flush()
    rerender({ sessionId: `${sessionId}-other` })
    await flush()
    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')
    expect(catalogReads()).toHaveLength(3)
    unmount()
  })

  it('applies nothing and keeps nothing when the answer lands after the chat closed', async () => {
    const waited = deferred()
    answerCatalog([
      () => Promise.resolve(LISTING),
      () => waited.promise,
      () => Promise.resolve(UNKNOWN)
    ])
    const first = renderOptions()
    await flush()
    first.unmount()
    waited.resolve(HOST_CATALOG)
    await flush()
    // A later open of the same chat asks afresh instead of joining a finished wait.
    const { result, unmount } = renderOptions()
    await flush()
    expect(catalogReads()).toHaveLength(3)
    expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')
    unmount()
  })
})
