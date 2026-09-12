// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  operationId: vi.fn(),
  enqueueSettingsWrite: vi.fn()
}))
let fence = 3
let sessionCommands: { name: string; kind: 'command' | 'skill' }[] | undefined
let items: AgentJournalRenderItem[] = []
let submissions: AgentJournalSubmission[] = []

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
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

vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: mocks.operationId,
  useStructuredAgentSessionOutbox: () => ({
    outbox: [],
    blockedClientMessageId: null,
    error: null,
    send: vi.fn(),
    retry: vi.fn()
  })
}))

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  applyNativeChatSessionOptionSettingsMutation,
  resolveStructuredLaunchSeedOptions
} from '../../../../shared/native-chat-session-option-defaults'
import type { PersistedNativeChatSessionOptions } from '../../../../shared/native-chat-session-options'
import { useStructuredAgentSession } from './use-structured-agent-session'

/** Replay every host mutation in order, exactly as the runtime does. */
function seededByNextLaunch(): Record<string, string> | undefined {
  let persisted: PersistedNativeChatSessionOptions | undefined
  for (const [, mutation] of mocks.enqueueSettingsWrite.mock.calls) {
    persisted =
      applyNativeChatSessionOptionSettingsMutation(
        persisted,
        mutation as Parameters<typeof applyNativeChatSessionOptionSettingsMutation>[1]
      ) ?? persisted
  }
  return resolveStructuredLaunchSeedOptions(persisted, 'codex')
}

const LOCAL_TARGET = { kind: 'local' } as const

const OPTIONS = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    },
    {
      id: 'gpt-fast',
      label: 'GPT Fast',
      isDefault: false,
      defaultEffort: 'low',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' }
      ]
    }
  ],
  current: { model: 'gpt-live', effort: 'medium' }
}

describe('useStructuredAgentSession working state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fence = 3
    items = []
    submissions = []
    mocks.call.mockResolvedValue(null)
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
    // Only the provider can mint a cancellable turn, so Stop stays unavailable here.
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

  it('keeps a prompted provider turn working and cancellable beneath presentation policy', () => {
    items = [
      {
        itemId: 'turn-1',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'turn', turnId: 'provider-turn', state: 'running' }
      },
      {
        itemId: 'question-1',
        revision: 1,
        sequence: 2,
        observedAt: 2,
        body: {
          kind: 'question',
          question: 'Which approach?',
          options: [{ id: 'focused', label: 'Focused' }],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }
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
    expect(result.current.turnId).toBe('provider-turn')
    expect(result.current.prompts).toHaveLength(1)
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
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
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
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(false)
    })

    expect(result.current.error).toBe('provider rejected option')
    expect(result.current.optionSnapshot.find((entry) => entry.id === 'model')).toMatchObject({
      settable: true
    })
  })

  it('mints a fresh operation when the same option is retried after a typed refusal', async () => {
    let attempts = 0
    mocks.call.mockImplementation((_target, method) => {
      if (method !== 'agentSession.setOption') {
        // The hook also holds the session while it is mounted; only option writes are attempts.
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
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(false)
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })

    const mutations = mocks.call.mock.calls.filter(
      ([, method]) => method === 'agentSession.setOption'
    )
    expect(
      mutations.map(
        ([, , params]) =>
          (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
      )
    ).toEqual(['operation-1', 'operation-2'])
  })

  it('reuses an option operation after a pending admission refusal', async () => {
    let attempts = 0
    mocks.call.mockImplementation((_target, method) => {
      if (method !== 'agentSession.setOption') {
        // The hook also holds the session while it is mounted; only option writes are attempts.
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
    const { result, rerender } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(false)
    })
    fence = 4
    rerender()
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))
    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })

    const mutations = mocks.call.mock.calls.filter(
      ([, method]) => method === 'agentSession.setOption'
    )
    expect(
      mutations.map(
        ([, , params]) =>
          (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
      )
    ).toEqual(['operation-1', 'operation-1'])
    expect(
      mutations.map(
        ([, , params]) =>
          (params as { envelope: { expectedRuntimeFence: number } }).envelope.expectedRuntimeFence
      )
    ).toEqual([3, 4])
    expect(mocks.operationId).toHaveBeenCalledTimes(1)
  })

  it('ignores an option failure from a superseded fence', async () => {
    let reject!: (error: Error) => void
    const pending = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise
    })
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options' ? Promise.resolve(OPTIONS) : pending
    )
    const { result, rerender } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))
    let setting!: Promise<boolean>
    act(() => {
      setting = result.current.setStructuredOption('model', 'gpt-fast')
    })
    fence = 4
    rerender()

    await act(async () => {
      reject(new Error('stale provider failure'))
      await setting
    })

    expect(result.current.error).toBeNull()
  })

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

  it('remembers a model pick so the next launch seeds the pair the provider settled on', async () => {
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
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(true)
    })

    expect(seededByNextLaunch()).toEqual({ model: 'gpt-fast', effort: 'low' })
    expect(mocks.enqueueSettingsWrite).toHaveBeenCalledWith(LOCAL_TARGET, {
      type: 'apply-picks',
      agent: 'codex',
      picks: [
        { modelId: 'gpt-fast', optionId: 'model', value: 'gpt-fast' },
        { modelId: 'gpt-fast', optionId: 'effort', value: 'low' }
      ]
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
      expect.objectContaining({ type: 'apply-picks', agent: 'codex' })
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
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('effort', 'high')).toBe(true)
    })

    // Without the model the launch resolves nothing, so the remembered effort would be dead.
    expect(seededByNextLaunch()).toEqual({ model: 'gpt-live', effort: 'high' })
  })

  it('remembers nothing when the provider refuses the pick', async () => {
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.options'
        ? Promise.resolve(OPTIONS)
        : Promise.reject(new Error('provider rejected option'))
    )
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    await waitFor(() => expect(result.current.optionSnapshot).toHaveLength(2))

    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-fast')).toBe(false)
    })

    expect(mocks.enqueueSettingsWrite).not.toHaveBeenCalled()
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
      // t2 is still running, so the host has no duration for it: an explicit null
      // that outranks whatever this client clocked locally.
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
