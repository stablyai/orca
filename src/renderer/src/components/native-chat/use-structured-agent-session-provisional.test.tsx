// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>(),
  hold: vi.fn<(args: { enabled?: boolean }) => void>(),
  read: vi.fn<(args: { isVisible?: boolean }) => void>(),
  outbox: vi.fn<(args: { fence: number | null; submissions: readonly unknown[] }) => void>(),
  send: vi.fn<(text: string) => boolean>(),
  retry: vi.fn<(clientMessageId: string) => void>()
}))

let readState: StructuredAgentSessionState

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
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

vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: () => 'operation-1',
  useStructuredAgentSessionOutbox: (args: {
    fence: number | null
    submissions: readonly unknown[]
  }) => {
    mocks.outbox(args)
    return {
      outbox: [],
      blockedClientMessageId: null,
      error: null,
      send: mocks.send,
      retry: mocks.retry
    }
  }
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn<(target: unknown, mutation: unknown) => Promise<void>>()
}))

import { useStructuredAgentSession } from './use-structured-agent-session'

const LOCAL_TARGET = { kind: 'local' } as const
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
    retainedItemLimit: 1_024,
    hasOlder: true,
    status: 'error',
    error: 'cached transport error',
    handoff: null,
    optionsRevision: 0,
    commands: [{ name: 'provider-command', kind: 'command' }]
  }
}

describe('useStructuredAgentSession provisional launch gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readState = sessionState()
    mocks.send.mockReturnValue(true)
    mocks.call.mockResolvedValue(OPTIONS)
  })

  it('keeps local sends usable while withholding every provider surface', async () => {
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: LOCAL_TARGET,
        agent: 'codex',
        isVisible: true,
        transportEnabled: false
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
      conversationCommands: [],
      optionSnapshot: []
    })
    expect(result.current.sessionCommands).toBeUndefined()
    expect(result.current.optionSurface.getSnapshot()).toEqual([])
    expect(result.current.send('queued while launching')).toBe(true)
    expect(mocks.send).toHaveBeenCalledWith('queued while launching')

    await act(async () => {
      await result.current.cancel('turn-1')
      await result.current.stopBackgroundTask('task-1')
      expect(await result.current.setStructuredOption('model', 'gpt-live')).toBe(false)
    })

    expect(mocks.call).not.toHaveBeenCalled()
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

    expect(mocks.call).not.toHaveBeenCalled()
    rerender({ transportEnabled: true })

    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(LOCAL_TARGET, 'agentSession.options', {
        sessionId: 'session-1'
      })
    )
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(mocks.hold).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }))
    expect(mocks.read).toHaveBeenLastCalledWith(expect.objectContaining({ isVisible: true }))
    expect(mocks.outbox).toHaveBeenLastCalledWith(
      expect.objectContaining({ fence: 3, submissions: [] })
    )
  })
})
