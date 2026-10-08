// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'

const mocks = vi.hoisted(() => {
  const pending: StructuredAgentSessionPendingSend[] = []
  return {
    call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>(),
    hold: vi.fn((_args: { enabled?: boolean }) => ({ error: null })),
    read: vi.fn<(args: { isVisible?: boolean }) => void>(),
    outbox: vi.fn<(args: { fence: number | null; submissions: readonly unknown[] }) => void>(),
    send: vi.fn<(text: string) => boolean>(),
    stopSends: vi.fn<() => void>(),
    takeBackLaunchText: vi.fn<(sessionId: string) => void>(),
    pending
  }
})

let readState: StructuredAgentSessionState

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionQuietRepeatedStop: vi.fn(async () => false)
}))

vi.mock('./use-structured-agent-session-hold', () => ({
  useStructuredAgentSessionHold: (args: { enabled?: boolean }) => mocks.hold(args)
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: (args: { isVisible?: boolean }) => {
    mocks.read(args)
    return {
      state: readState,
      loadingOlder: false,
      loadOlder: vi.fn<() => Promise<void>>()
    }
  }
}))

vi.mock('./structured-agent-session-operation-id', () => ({
  structuredSessionOperationId: () => 'operation-1'
}))
vi.mock('./use-structured-agent-session-sends', () => ({
  useStructuredAgentSessionSends: (args: {
    fence: number | null
    submissions: readonly unknown[]
  }) => {
    mocks.outbox(args)
    return {
      pending: mocks.pending,
      error: null,
      send: mocks.send,
      stopSends: mocks.stopSends
    }
  }
}))

vi.mock('@/lib/structured-agent-session-launch-prompt', () => ({
  takeBackStructuredLaunchPrompts: mocks.takeBackLaunchText
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn<(target: unknown, mutation: unknown) => Promise<void>>()
}))

import { useStructuredAgentSession } from './use-structured-agent-session'

const LOCAL_TARGET = { kind: 'local' } as const

function methodsCalled(): string[] {
  return mocks.call.mock.calls.map(([, method]) => method)
}

function currentModel(snapshot: readonly { id: string; kind: { type: string } }[]) {
  const model = snapshot.find((entry) => entry.id === 'model')?.kind
  return model && 'currentValue' in model ? model.currentValue : undefined
}
const OPTIONS = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [{ value: 'medium', label: 'Medium' }]
    }
  ],
  current: { model: 'gpt-live', effort: 'medium' }
}

function sessionState(): StructuredAgentSessionState {
  return {
    epoch: 'epoch-1',
    cursor: null,
    fence: 3,
    items: [],
    submissions: [],
    retainedOwnItemLimit: 1_024,
    retainedItemCap: 8_192,
    hasOlder: true,
    status: 'error',
    error: 'cached transport error',
    commands: [{ name: 'provider-command', kind: 'command' }]
  }
}

describe('useStructuredAgentSession provisional launch gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pending = []
    readState = sessionState()
    mocks.send.mockReturnValue(true)
    mocks.call.mockResolvedValue(OPTIONS)
  })

  it('keeps local sends usable while withholding every provider surface but the picker', async () => {
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true,
        transportEnabled: false,
        launch: { kind: 'new', seedOptions: { model: 'gpt-5.5' }, heldOptions: {} }
      })
    )

    expect(mocks.hold).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }))
    expect(mocks.read).toHaveBeenLastCalledWith(expect.objectContaining({ isVisible: false }))
    expect(mocks.outbox).toHaveBeenLastCalledWith(
      expect.objectContaining({ fence: null, submissions: [] })
    )
    expect(result.current).toMatchObject({
      status: 'ready',
      error: null,
      hasOlder: false,
      loadingOlder: false,
      journalItems: [],
      prompts: [],
      conversationCommands: []
    })
    expect(result.current.sessionCommands).toBeUndefined()
    // The picker shows the selection the create seeds, from the first frame.
    expect(currentModel(result.current.optionSnapshot)).toBe('gpt-5.5')
    expect(result.current.optionSurface.getSnapshot()).toBe(result.current.optionSnapshot)
    expect(result.current.send('queued while launching')).toBe(true)
    expect(mocks.send).toHaveBeenCalledWith('queued while launching')

    await act(async () => {
      await result.current.cancel('turn-1')
      await result.current.stopBackgroundTask('task-1')
    })

    expect(methodsCalled()).toEqual(['agentSession.modelCatalog'])
  })

  it("offers Stop while the launch's text waits on an unpublished chat, and takes it back locally", async () => {
    const render = () =>
      renderHook(() =>
        useStructuredAgentSession({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          agent: 'grok',
          isVisible: true,
          transportEnabled: false,
          launch: { kind: 'new', heldOptions: {} }
        })
      )
    expect(render().result.current.canStop).toBe(false)
    mocks.pending = [
      {
        clientMessageId: 'sent-while-starting',
        sessionId: 'session-1',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
        previewUris: [],
        queuedAt: 1,
        phase: 'sending',
        issued: false
      }
    ]
    const { result } = render()
    expect(result.current.canStop).toBe(true)

    await act(async () => {
      await result.current.stop()
    })

    expect(mocks.takeBackLaunchText).toHaveBeenCalledWith('session-1')
    expect(mocks.stopSends).toHaveBeenCalledTimes(1)
    // Nothing reached a host, so nothing is asked of one.
    expect(methodsCalled().filter((method) => method === 'agentSession.cancel')).toEqual([])
  })

  it('shows no stored selection for a chat this view did not launch', () => {
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true
      })
    )
    // A reopened chat runs its own recorded options until the live read reports them.
    expect(currentModel(result.current.optionSnapshot)).toBeUndefined()
  })

  it('activates provider surfaces after publication without repeating option discovery', async () => {
    const { rerender } = renderHook(
      ({ transportEnabled }: { transportEnabled: boolean }) =>
        useStructuredAgentSession({
          sessionId: 'session-1',
          target: LOCAL_TARGET,
          agent: 'codex',
          isVisible: true,
          transportEnabled
        }),
      { initialProps: { transportEnabled: false } }
    )

    expect(methodsCalled()).toEqual(['agentSession.modelCatalog'])
    rerender({ transportEnabled: true })

    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(LOCAL_TARGET, 'agentSession.options', {
        sessionId: 'session-1'
      })
    )
    expect(methodsCalled().filter((method) => method === 'agentSession.options')).toHaveLength(1)
    expect(mocks.hold).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }))
    expect(mocks.read).toHaveBeenLastCalledWith(expect.objectContaining({ isVisible: true }))
    expect(mocks.outbox).toHaveBeenLastCalledWith(
      expect.objectContaining({ fence: 3, submissions: [] })
    )
  })
})
