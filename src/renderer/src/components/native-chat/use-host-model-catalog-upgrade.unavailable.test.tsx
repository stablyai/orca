// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// The host's sign-in verdict as a chat holds it: kept until the next answer replaces it, read
// again on window focus only while it is said, and cleared by a failed read.

const LOCAL_TARGET = { kind: 'local' } as const
const SIGNED_OUT = { reason: 'notSignedIn', account: 'system' } as const
const HOST_CATALOG = {
  origin: 'probe',
  models: [
    { id: 'gpt-hosted', label: 'GPT Hosted', isDefault: true, efforts: [] },
    // The launch seed's model: a saved pick no host list names shows only the placeholder.
    { id: 'gpt-5.5', label: 'GPT-5.5', efforts: [] }
  ],
  fetchedAt: 1_000
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no test here sends a pick, so mutate is never called.
const mutate = vi.fn(async () => null) as unknown as StructuredAgentSessionMutate

let sessionId = ''
let sessionCount = 0

const NO_TURN: { turnId: string | null; providerRunning?: boolean } = { turnId: null }

function renderOptions() {
  return renderHook(
    ({ turnId, providerRunning }: { turnId: string | null; providerRunning?: boolean }) =>
      useStructuredAgentSessionOptions({
        agent: 'codex',
        sessionId,
        target: LOCAL_TARGET,
        transportEnabled: false,
        isVisible: true,
        providerVisible: false,
        fence: null,
        turnId,
        ...(providerRunning ? { providerRunning } : {}),
        unloadedTurnRevisions: undefined,
        mutate,
        launch: { kind: 'new', seedOptions: { model: 'gpt-5.5' }, heldOptions: {} }
      }),
    { initialProps: NO_TURN }
  )
}

type Answer = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

/** Every catalog read waits for the test to answer it, in order. */
function catalogReads() {
  const pending: Answer[] = []
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.modelCatalog'
      ? new Promise((resolve, reject) => pending.push({ resolve, reject }))
      : new Promise(() => {})
  )
  return {
    count: () =>
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.modelCatalog').length,
    params: (index: number) =>
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.modelCatalog')[
        index
      ]?.[2],
    answer: async (index: number, value: unknown) => {
      pending[index]!.resolve(value)
      await act(async () => {})
    },
    fail: async (index: number) => {
      pending[index]!.reject(new Error('runtime_unavailable'))
      await act(async () => {})
    }
  }
}

function modelChoices(snapshot: readonly SessionOptionDescriptor[]): string[] {
  const descriptor = snapshot.find((entry) => entry.id === 'model')!
  return descriptor.kind.type === 'select' ? descriptor.kind.choices.map((c) => c.value) : []
}

/** The model pill is open for a pick: settable, not disabled, and offering `choice`. */
function expectPickerUsable(snapshot: readonly SessionOptionDescriptor[], choice: string): void {
  const model = snapshot.find((entry) => entry.id === 'model')
  expect(model?.settable).toBe(true)
  expect(model?.disabledReason).toBeUndefined()
  expect(modelChoices(snapshot)).toContain(choice)
}

const focusWindow = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('focus'))
  })

describe("a chat's sign-in verdict", () => {
  beforeEach(() => {
    mocks.call.mockReset()
    resetHostModelCatalogSnapshotsForTests()
    sessionCount += 1
    sessionId = `verdict-session-${sessionCount}`
  })
  // A mounted chat still holding a verdict from an earlier test would read on this test's focus.
  afterEach(cleanup)

  it('holds the verdict through a re-read and lets only its answer clear it', async () => {
    const reads = catalogReads()
    const { result } = renderOptions()
    await reads.answer(0, { ...HOST_CATALOG, unavailable: SIGNED_OUT })
    expect(result.current.unavailable).toEqual(SIGNED_OUT)
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')

    await focusWindow()
    expect(reads.count()).toBe(2)
    await reads.answer(1, { ...HOST_CATALOG, unavailable: SIGNED_OUT })
    await focusWindow()
    expect(reads.count()).toBe(3)
    // The notice does not flicker off while the re-read is out.
    expect(result.current.unavailable).toEqual(SIGNED_OUT)
    await reads.answer(2, HOST_CATALOG)
    expect(result.current.unavailable).toBeNull()
  })

  it('reads again when a turn starts while a verdict is said: the start made the host re-check', async () => {
    const reads = catalogReads()
    const { rerender } = renderOptions()
    await reads.answer(0, { ...HOST_CATALOG, unavailable: SIGNED_OUT })
    await act(async () => rerender({ turnId: 'turn-1' }))
    expect(reads.count()).toBe(2)
    await reads.answer(1, { ...HOST_CATALOG, unavailable: SIGNED_OUT })
    // The turn ending reads once more.
    await act(async () => rerender({ turnId: null }))
    expect(reads.count()).toBe(3)
  })

  // A verdict the agent's own start gave ends with that agent: the idle sweep stopping it is read.
  it("reads again when the chat's agent stops or starts", async () => {
    const reads = catalogReads()
    const { result, rerender } = renderOptions()
    await act(async () => rerender({ turnId: null, providerRunning: true }))
    expect(reads.count()).toBe(2)
    await reads.answer(1, { origin: 'unknown', unavailable: SIGNED_OUT })
    expect(result.current.unavailable).toEqual(SIGNED_OUT)
    await act(async () => rerender({ turnId: null, providerRunning: false }))
    expect(reads.count()).toBe(3)
    await reads.answer(2, { origin: 'unknown' })
    expect(result.current.unavailable).toBeNull()
  })

  it('drops a signed-out answer read before the agent stopped', async () => {
    const reads = catalogReads()
    const { result, rerender } = renderOptions()
    await act(async () => rerender({ turnId: null, providerRunning: true }))
    await act(async () => rerender({ turnId: null, providerRunning: false }))
    expect(reads.count()).toBe(3)
    await reads.answer(1, { origin: 'unknown', unavailable: SIGNED_OUT })
    expect(result.current.unavailable).toBeNull()
    await reads.answer(2, { origin: 'unknown' })
    expect(result.current.unavailable).toBeNull()
  })

  it('a turn starting with no verdict reads nothing more', async () => {
    const reads = catalogReads()
    const { rerender } = renderOptions()
    await reads.answer(0, HOST_CATALOG)
    await act(async () => rerender({ turnId: 'turn-1' }))
    expect(reads.count()).toBe(1)
  })

  it('reads again on window focus only while a verdict is said', async () => {
    const reads = catalogReads()
    renderOptions()
    await reads.answer(0, HOST_CATALOG)
    await focusWindow()
    expect(reads.count()).toBe(1)
  })

  it('clears on a failed read: unknown shows nothing', async () => {
    const reads = catalogReads()
    const { result } = renderOptions()
    await reads.answer(0, { origin: 'unknown', unavailable: SIGNED_OUT })
    await focusWindow()
    await reads.fail(1)
    expect(result.current.unavailable).toBeNull()
  })

  it('never newly shows a reason the host is still re-checking: a fixed sign-in does not flash', async () => {
    const reads = catalogReads()
    const { result } = renderOptions()
    await reads.answer(0, { ...HOST_CATALOG, unavailable: SIGNED_OUT, listingInProgress: true })
    expect(reads.count()).toBe(2)
    expect(reads.params(1)).toEqual({ agent: 'codex', sessionId, waitForListing: true })
    // The catalog in hand is shown; only the notice waits on the answer.
    expectPickerUsable(result.current.optionSnapshot, 'gpt-hosted')
    expect(result.current.unavailable).toBeNull()
    await reads.answer(1, HOST_CATALOG)
    expect(result.current.unavailable).toBeNull()
  })

  it('shows a re-checked reason once the probe confirms it', async () => {
    const reads = catalogReads()
    const { result } = renderOptions()
    await reads.answer(0, { origin: 'unknown', unavailable: SIGNED_OUT, listingInProgress: true })
    expect(result.current.unavailable).toBeNull()
    await reads.answer(1, { origin: 'unknown', unavailable: SIGNED_OUT })
    expect(result.current.unavailable).toEqual(SIGNED_OUT)
  })

  it('keeps a shown reason, and the picker usable, while the host re-checks it', async () => {
    const reads = catalogReads()
    const { result } = renderOptions()
    await reads.answer(0, { origin: 'unknown', unavailable: SIGNED_OUT })
    await focusWindow()
    await reads.answer(1, { origin: 'unknown', unavailable: SIGNED_OUT, listingInProgress: true })
    expect(result.current.unavailable).toEqual(SIGNED_OUT)
    expect(reads.params(2)).toEqual({ agent: 'codex', sessionId, waitForListing: true })
    expectPickerUsable(result.current.optionSnapshot, 'gpt-5.5')
    await reads.answer(2, { origin: 'unknown' })
    expect(result.current.unavailable).toBeNull()
  })
})
