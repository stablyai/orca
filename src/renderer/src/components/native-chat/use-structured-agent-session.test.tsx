// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  startCapability: vi.fn(),
  startDetail: vi.fn(),
  operationId: vi.fn(),
  enqueueSettingsWrite: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))
let fence = 3
let sessionCommands: { name: string; kind: 'command' | 'skill' }[] | undefined
let items: AgentJournalRenderItem[] = []
let submissions: AgentJournalSubmission[] = []

vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() })),
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionItemDetail: mocks.startCapability,
  readStructuredAgentSessionItem: mocks.startDetail,
  supportsStructuredAgentSessionQuietRepeatedStop: vi.fn(async () => false)
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.enqueueSettingsWrite
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence,
      commands: sessionCommands,
      items,
      submissions,
      status: 'ready',
      error: null,
      hasOlder: false,
      handoff: null
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('./structured-agent-session-operation-id', () => ({
  structuredSessionOperationId: mocks.operationId
}))
vi.mock('./use-structured-agent-session-sends', () => ({
  useStructuredAgentSessionSends: () => ({
    pending: [],
    error: null,
    send: vi.fn(),
    stopSends: vi.fn()
  })
}))

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  OPTIONS,
  FAST_OPTIONS,
  seededByNextLaunch
} from './structured-session-option-defaults.test-fixture'
import { useStructuredAgentSession } from './use-structured-agent-session'

import { useAppStore } from '@/store'
import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'

beforeEach(() => {
  useAppStore.getState().setRuntimeEnvironments([
    {
      id: 'remote-1',
      name: 'Original host',
      createdAt: 1,
      updatedAt: 1,
      pairingRevision: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [],
      preferredEndpointId: 'original'
    }
  ])
})
afterEach(() => {
  cleanup()
  forgetStructuredSessionSelection('session-1')
  forgetStructuredSessionSelection('replacement-pane')
  useAppStore.getState().setRuntimeEnvironments([])
})

const LOCAL_TARGET = { kind: 'local' } as const

function renderOptionsSession() {
  return renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      target: LOCAL_TARGET,
      agent: 'codex',
      isVisible: true
    })
  )
}

describe('useStructuredAgentSession working state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    mocks.call.mockResolvedValue(null)
  })

  it('renders full immutable creation facts without acquisition or pending work', async () => {
    const previousItems = items
    const previousSubmissions = submissions
    items = [
      {
        itemId: 'start',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'agent-start',
          dispatchId: 'dispatch',
          task: 'Full task',
          worker: {
            party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null },
            name: 'Worker'
          }
        }
      }
    ]
    submissions = []
    let pending = 0
    mocks.startCapability.mockResolvedValue(true)
    mocks.startDetail.mockImplementation(() => {
      pending++
      return new Promise(() => {})
    })
    const mounted = renderOptionsSession()
    try {
      await act(async () => {})
      expect(mounted.result.current.messages).toEqual([
        expect.objectContaining({ agentStart: true, blocks: [{ type: 'text', text: 'Full task' }] })
      ])
      const first = mounted.result.current.messages[0]
      items = [...items]
      await act(async () => mounted.rerender())
      expect(mounted.result.current.messages[0]).toBe(first)
      expect(mocks.startCapability).not.toHaveBeenCalled()
      expect(mocks.startDetail).not.toHaveBeenCalled()
      expect(pending).toBe(0)
    } finally {
      mounted.unmount()
      items = previousItems
      submissions = previousSubmissions
    }
  })

  it('reports work from an unanswered dispatch, and keeps the turn id provider-minted', () => {
    submissions = [
      {
        clientMessageId: 'client-1',
        fence: 3,
        payloadFingerprint: 'fingerprint-1',
        dispatchState: 'pending',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    ]
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        agent: 'codex',
        target: LOCAL_TARGET,
        isVisible: true
      })
    )

    expect(result.current.isWorking).toBe(true)
    expect(result.current.turnId).toBeNull()
  })

  it('reports no work once the dispatch resolves and no turn is running', () => {
    submissions = [
      {
        clientMessageId: 'client-1',
        fence: 3,
        payloadFingerprint: 'fingerprint-1',
        dispatchState: 'accepted',
        providerItemId: 'codex:thread-1:turn-1',
        reason: null,
        submittedAt: 1,
        resolvedAt: 2
      }
    ]
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        agent: 'codex',
        target: LOCAL_TARGET,
        isVisible: true
      })
    )

    expect(result.current.isWorking).toBe(false)
  })
})

describe('useStructuredAgentSession options', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    submissions = []
    mocks.operationId
      .mockReset()
      .mockReturnValueOnce('operation-1')
      .mockReturnValueOnce('operation-2')
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options' ? Promise.resolve(OPTIONS) : Promise.resolve(null)
    )
  })

  it('applies provider-reconciled values after a model change', async () => {
    let changed = false
    mocks.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.options') {
        return Promise.resolve(
          changed ? { ...OPTIONS, current: { model: 'gpt-fast', effort: 'low' } } : OPTIONS
        )
      }
      changed = true
      return Promise.resolve({
        ok: true,
        value: {
          key: 'model',
          value: 'gpt-fast',
          options: { model: 'gpt-fast', effort: 'low' }
        }
      })
    })
    const { result } = renderOptionsSession()
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })

    expect(result.current.optionSnapshot.find((entry) => entry.id === 'model')?.kind).toMatchObject(
      {
        currentValue: 'gpt-fast'
      }
    )
    expect(
      result.current.optionSnapshot.find((entry) => entry.id === 'effort')?.kind
    ).toMatchObject({
      currentValue: 'low'
    })
  })

  it('surfaces a rejected option transport call and clears pending state', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.reject(new Error('provider rejected option'))
    )
    const { result } = renderOptionsSession()
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })

    // Show one uncertainty notice without raw transport text or an unproved outcome.
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Orca couldn't confirm what happened. Check the chat."
    )
    expect(mocks.enqueueSettingsWrite).not.toHaveBeenCalled()
    expect(result.current.error).toBeNull()
    expect(result.current.optionSnapshot.find((entry) => entry.id === 'model')).toMatchObject({
      settable: true
    })
  })

  it('mints a fresh operation when the same option is retried after a typed refusal', async () => {
    let attempts = 0
    mocks.call.mockImplementation((_target, method) => {
      if (method !== 'agentSession.setOption') {
        return Promise.resolve(method === 'agentSession.options' ? OPTIONS : null)
      }
      attempts += 1
      return Promise.resolve(
        attempts === 1
          ? {
              ok: false,
              refusal: {
                code: 'agent_session_operation_invalid',
                message: 'model list unavailable'
              }
            }
          : {
              ok: true,
              value: {
                key: 'model',
                value: 'gpt-fast',
                options: { model: 'gpt-fast', effort: 'low' }
              }
            }
      )
    })
    const { result } = renderOptionsSession()
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(false)
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })

    const mutations = mocks.call.mock.calls.filter(
      ([, method]) => method === 'agentSession.setOption'
    )
    const ids = mutations.map(
      ([, , params]) =>
        (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
    )
    expect(ids).toEqual([expect.any(String), expect.any(String)])
    expect(ids.every((id) => id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(2)
  })

  it('sends the pick again as a new operation after a pending admission refusal', async () => {
    const refreshedOptions = Promise.withResolvers<typeof OPTIONS>()
    let attempts = 0
    mocks.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.options' && fence === 4) {
        return refreshedOptions.promise
      }
      if (method !== 'agentSession.setOption') {
        return Promise.resolve(method === 'agentSession.options' ? OPTIONS : null)
      }
      attempts += 1
      return Promise.resolve(
        attempts === 1
          ? {
              ok: false,
              refusal: {
                code: 'agent_session_checkpoint_stale',
                message: 'runtime fence advanced',
                currentFence: 4
              }
            }
          : {
              ok: true,
              replayed: false,
              value: {
                key: 'model',
                value: 'gpt-fast',
                options: { model: 'gpt-fast', effort: 'low' }
              }
            }
      )
    })
    const { result, rerender } = renderOptionsSession()
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(false)
    })
    fence = 4
    rerender()
    expect(result.current.optionSnapshot.every((entry) => !entry.settable)).toBe(true)
    await act(async () => refreshedOptions.resolve(OPTIONS))
    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })

    const mutations = mocks.call.mock.calls.filter(
      ([, method]) => method === 'agentSession.setOption'
    )
    const ids = mutations.map(
      ([, , params]) =>
        (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
    )
    expect(ids).toEqual([expect.any(String), expect.any(String)])
    expect(ids.every((id) => id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(2)
    expect(
      mutations.map(
        ([, , params]) =>
          (params as { envelope: { expectedRuntimeFence: number } }).envelope.expectedRuntimeFence
      )
    ).toEqual([3, 4])
  })

  it.each(['same-pane', 'replacement', 'unmounted'] as const)(
    'keeps uncertainty presentation with its issuing pane across startup (%s)',
    async (schedule) => {
      let reject!: (error: Error) => void
      const pending = new Promise<never>((_resolve, rejectPromise) => {
        reject = rejectPromise
      })
      mocks.call.mockImplementation((_target, method) =>
        method === 'agentSession.options' || method === 'agentSession.hold'
          ? Promise.resolve(method === 'agentSession.options' ? OPTIONS : null)
          : pending
      )
      const { result, rerender, unmount } = renderHook(
        ({ sessionId }) =>
          useStructuredAgentSession({
            sessionId,
            target: LOCAL_TARGET,
            agent: 'codex',
            isVisible: true
          }),
        { initialProps: { sessionId: 'session-1' } }
      )
      await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))
      let setting!: Promise<boolean>
      act(() => {
        setting = result.current.setStructuredOption('model', 'gpt-fast')
      })
      fence = 4
      rerender({ sessionId: schedule === 'replacement' ? 'replacement-pane' : 'session-1' })
      if (schedule === 'unmounted') {
        unmount()
      }

      await act(async () => {
        reject(new Error('stale provider failure'))
        expect(await setting).toBe(true)
      })

      expect(result.current.error).toBeNull()
      expect(mocks.toastError).toHaveBeenCalledTimes(schedule === 'same-pane' ? 1 : 0)
      if (schedule === 'same-pane') {
        expect(mocks.toastError).toHaveBeenCalledWith(
          "Orca couldn't confirm what happened. Check the chat."
        )
      }
      expect(mocks.enqueueSettingsWrite).not.toHaveBeenCalled()
      expect(
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.setOption')
      ).toHaveLength(1)
    }
  )

  it('includes one background task id in the cancel fingerprint and payload', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.resolve({
            ok: true,
            value: { turnId: 'background-tasks', cancelled: true }
          })
    )
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'claude',
        isVisible: true
      })
    )

    await act(async () => {
      await expect(result.current.stopBackgroundTask('task-2')).resolves.toMatchObject({
        cancelled: true
      })
    })

    const mutation = mocks.call.mock.calls.find(([, method]) => method === 'agentSession.cancel')
    expect(mutation?.[2]).toMatchObject({
      envelope: {
        sessionId: 'session-1',
        expectedRuntimeFence: 3
      },
      turnId: 'background-tasks',
      scope: 'background-tasks',
      taskId: 'task-2'
    })
  })

  it('remembers only the admitted model rather than reply-only companion effort', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.resolve({
            ok: true,
            value: {
              key: 'model',
              value: 'gpt-fast',
              options: { model: 'gpt-fast', effort: 'low' }
            }
          })
    )
    const { result } = renderOptionsSession()
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })

    expect(seededByNextLaunch(mocks.enqueueSettingsWrite.mock.calls)).toEqual({ model: 'gpt-fast' })
    expect(mocks.enqueueSettingsWrite).toHaveBeenCalledWith(LOCAL_TARGET, {
      type: 'apply-picks',
      agent: 'codex',
      picks: [{ modelId: 'gpt-fast', optionId: 'model', value: 'gpt-fast' }]
    })
  })

  it('writes through the session runtime target', async () => {
    const remoteTarget = { kind: 'environment', environmentId: 'remote-1' } as const
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.resolve({
            ok: true,
            value: { key: 'effort', value: 'high', options: { effort: 'high' } }
          })
    )
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: remoteTarget,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('effort', 'high')).toBe(true)
    })

    expect(mocks.enqueueSettingsWrite).toHaveBeenCalledWith(
      remoteTarget,
      expect.objectContaining({ type: 'apply-picks', agent: 'codex' }),
      { expectedEnvironmentPairingRevision: 1 }
    )
  })

  it('pins the model an effort-only pick was made against', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.resolve({
            ok: true,
            value: { key: 'effort', value: 'high', options: { effort: 'high' } }
          })
    )
    const { result } = renderOptionsSession()
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('effort', 'high')).toBe(true)
    })

    // Without the model the launch resolves nothing, so the remembered effort would be dead.
    expect(seededByNextLaunch(mocks.enqueueSettingsWrite.mock.calls)).toEqual({
      model: 'gpt-live',
      effort: 'high'
    })
  })

  it('remembers nothing when the transport leaves the pick unconfirmed', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.reject(new Error('provider rejected option'))
    )
    const { result } = renderOptionsSession()
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })

    expect(mocks.enqueueSettingsWrite).not.toHaveBeenCalled()
  })

  it('projects supported Fast off and hides the option when old hosts omit capability facts', async () => {
    mocks.call.mockImplementation((_target, method) =>
      Promise.resolve(method === 'agentSession.options' ? FAST_OPTIONS : null)
    )
    const supported = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-supported',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() =>
      expect(
        supported.result.current.optionSnapshot.find((entry) => entry.id === 'fastMode')?.kind
      ).toMatchObject({ currentValue: false })
    )
    supported.unmount()

    mocks.call.mockImplementation((_target, method) =>
      Promise.resolve(method === 'agentSession.options' ? OPTIONS : null)
    )
    const legacy = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-legacy',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(legacy.result.current.optionSnapshot).toHaveLength(2))
    expect(legacy.result.current.optionSnapshot.some((entry) => entry.id === 'fastMode')).toBe(
      false
    )
  })

  it('encodes Fast writes at the structured boundary and persists canonical booleans', async () => {
    let fastMode = false
    mocks.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.options') {
        return Promise.resolve({
          ...FAST_OPTIONS,
          current: { ...FAST_OPTIONS.current, fastMode }
        })
      }
      fastMode = true
      return Promise.resolve({
        ok: true,
        value: {
          key: 'fastMode',
          value: 'true',
          options: { model: 'gpt-live', effort: 'medium', fastMode: 'true' }
        }
      })
    })
    const { result } = renderOptionsSession()
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(3))

    await act(async () => {
      expect(await result.current.setStructuredOption('fastMode', true)).toBe(true)
    })

    const mutation = mocks.call.mock.calls.find(([, method]) => method === 'agentSession.setOption')
    expect(mutation?.[2]).toMatchObject({ key: 'fastMode', value: 'true' })
    expect(
      result.current.optionSnapshot.find((entry) => entry.id === 'fastMode')?.kind
    ).toMatchObject({ currentValue: true })
    expect(mocks.enqueueSettingsWrite).toHaveBeenCalledWith(LOCAL_TARGET, {
      type: 'apply-picks',
      agent: 'codex',
      picks: [{ modelId: 'gpt-live', optionId: 'fastMode', value: true }]
    })
    expect(seededByNextLaunch(mocks.enqueueSettingsWrite.mock.calls)).toEqual({
      model: 'gpt-live',
      fastMode: 'true'
    })
  })

  it('discards an option read that began before a Fast mutation', async () => {
    const staleRead = Promise.withResolvers<typeof FAST_OPTIONS>()
    let optionReads = 0
    mocks.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.modelCatalog') {
        return Promise.resolve({ origin: 'unknown' })
      }
      if (method === 'agentSession.options') {
        optionReads += 1
        if (optionReads === 1) {
          return Promise.resolve(FAST_OPTIONS)
        }
        if (optionReads === 2) {
          return staleRead.promise
        }
        return Promise.resolve({
          ...FAST_OPTIONS,
          current: { ...FAST_OPTIONS.current, fastMode: true }
        })
      }
      return Promise.resolve({
        ok: true,
        value: {
          key: 'fastMode',
          value: 'true',
          options: { model: 'gpt-live', effort: 'medium', fastMode: 'true' }
        }
      })
    })
    const { result, rerender } = renderOptionsSession()
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(3))
    items = [
      {
        itemId: 'turn-status',
        revision: 0,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'status',
          text: 'Working',
          turnLifecycle: { turnId: 'turn-1', state: 'running', startedAt: 1 }
        }
      }
    ]
    rerender()
    await waitFor(() => expect(optionReads).toBe(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('fastMode', true)).toBe(true)
    })
    await act(async () => {
      staleRead.resolve(FAST_OPTIONS)
      await staleRead.promise
    })

    expect(
      result.current.optionSnapshot.find((entry) => entry.id === 'fastMode')?.kind
    ).toMatchObject({ currentValue: true })
  })
})

describe('turn timing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    items = []
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options' ? Promise.resolve(OPTIONS) : Promise.resolve(null)
    )
  })

  it('exposes host-settled durations and a skew-free live anchor', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(50_000)
      const item = (
        itemId: string,
        observedAt: number,
        body: AgentJournalRenderItem['body']
      ): AgentJournalRenderItem => ({ itemId, revision: 0, sequence: observedAt, observedAt, body })
      const user: AgentJournalRenderItem['body'] = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'go' }]
      }
      items = [
        item('u1', 9_000_000, user),
        item('l1', 9_000_100, {
          kind: 'status',
          text: 'Done',
          turnLifecycle: {
            turnId: 't1',
            state: 'completed',
            startedAt: 9_000_000,
            completedAt: 9_004_000
          }
        }),
        item('u2', 9_010_000, user),
        item('l2', 9_010_300, {
          kind: 'status',
          text: 'Working',
          turnLifecycle: { turnId: 't2', state: 'running', startedAt: 9_010_000 }
        })
      ]
      const { result, rerender } = renderHook(() =>
        useStructuredAgentSession({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          agent: 'codex',
          isVisible: true
        })
      )
      expect(result.current.isWorking).toBe(true)
      expect(result.current.workingStartedAt).toBe(50_000 - 300)
      // A running turn’s explicit null duration outranks client-observed timing.
      expect([...result.current.settledTurns]).toEqual([
        ['u1', { startedAt: 9_000_000, workedSeconds: 4 }],
        ['u2', null]
      ])
      vi.setSystemTime(80_000)
      rerender()
      expect(result.current.workingStartedAt).toBe(50_000 - 300)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('session command catalog stream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    sessionCommands = undefined
    mocks.call.mockResolvedValue(OPTIONS)
  })

  const args = { sessionId: 'one', target: LOCAL_TARGET, agent: 'claude' as const, isVisible: true }
  const commands = [{ name: 'plugin:review', kind: 'skill' as const }]

  it('uses owner-scoped catalog state without a separate command RPC or stale cache', () => {
    sessionCommands = commands
    const { result, rerender } = renderHook((props) => useStructuredAgentSession(props), {
      initialProps: args
    })
    expect(result.current.sessionCommands).toEqual(commands)
    sessionCommands = undefined
    rerender({ ...args, sessionId: 'two' })
    expect(result.current.sessionCommands).toBeUndefined()
    sessionCommands = []
    rerender({ ...args, sessionId: 'two' })
    expect(result.current.sessionCommands).toEqual([])
    expect(
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.commands')
    ).toHaveLength(0)
  })

  it('adopts idle catalog updates and does no command reads on repeated transcript renders', () => {
    sessionCommands = commands
    const { result, rerender } = renderHook(() => useStructuredAgentSession(args))
    expect(result.current.sessionCommands).toEqual(commands)
    for (let index = 0; index < 30; index += 1) {
      rerender()
    }
    sessionCommands = []
    rerender()
    expect(result.current.sessionCommands).toEqual([])
    expect(
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.commands')
    ).toHaveLength(0)
  })
})

describe('structured option surface snapshot identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    items = []
    submissions = []
    mocks.call.mockResolvedValue(null)
  })

  /** The sibling PTY surface uses useSyncExternalStore; unstable snapshots would never quiesce. */
  it('returns the same snapshot instance for repeated reads at one state', async () => {
    mocks.call.mockResolvedValue(FAST_OPTIONS)
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        agent: 'codex',
        target: LOCAL_TARGET,
        isVisible: true
      })
    )
    await waitFor(() =>
      expect(result.current.optionSurface.getSnapshot().length).toBeGreaterThan(0)
    )
    expect(result.current.optionSurface.getSnapshot()).toBe(
      result.current.optionSurface.getSnapshot()
    )
  })
})
