// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { CONVERSATION_COMMAND_DEADLINE_MS } from './structured-conversation-command-claim'
import { useStructuredConversationCommand } from './use-structured-conversation-command'

const LOCAL_TARGET = { kind: 'local' } as const

function useCommandHarness(props: {
  fence: number
  items: readonly AgentJournalRenderItem[]
  sessionId?: string
  target?: RuntimeClientTarget
}) {
  const sessionId = props.sessionId ?? 'session-1'
  const target = props.target ?? LOCAL_TARGET
  const stateRef = useRef<{ fence: number | null }>({ fence: props.fence })
  useEffect(() => {
    stateRef.current = { fence: props.fence }
  }, [props.fence])
  const mutation = useStructuredAgentSessionMutate({
    sessionId,
    target,
    stateRef
  })
  const command = useStructuredConversationCommand({
    sessionId,
    target,
    fence: props.fence,
    items: props.items,
    blocked: false,
    mutate: mutation.mutateWithDisposition,
    onReconciled: mutation.clearWriteError
  })
  return { ...command, mutate: mutation.mutate, writeError: mutation.writeError }
}

function completedCompact(operationId: string): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(`compact:${operationId}`),
    revision: 2,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'status', text: 'Conversation compacted.' }
  }
}

describe('useStructuredConversationCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reuses an unresolved clear identity after a host restart', async () => {
    mocks.call.mockRejectedValue(new Error('connection lost'))
    const initialProps: { fence: number; items: AgentJournalRenderItem[] } = {
      fence: 1,
      items: []
    }
    const view = renderHook((props) => useCommandHarness(props), { initialProps })

    let first!: ReturnType<typeof view.result.current.run>
    act(() => {
      first = view.result.current.run('clear')
    })
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    expect(view.result.current.isRunning()).toBe(true)
    await waitFor(() => expect(view.result.current.writeError).toBeNull())
    const firstOperationId = mocks.call.mock.calls[0]![2].envelope.clientOperationId

    view.rerender({ fence: 2, items: [] })
    await expect(first).resolves.toMatchObject({ accepted: false })
    act(() => {
      void view.result.current.run('clear')
    })
    expect(mocks.call.mock.calls[1]![2].envelope.clientOperationId).toBe(firstOperationId)
    view.unmount()
  })

  it('keeps the replay identity when an old-fence reply arrives during recovery', async () => {
    const firstReply = Promise.withResolvers<unknown>()
    const replayReply = Promise.withResolvers<unknown>()
    mocks.call
      .mockReturnValueOnce(firstReply.promise)
      .mockReturnValueOnce(replayReply.promise)
      .mockImplementation(() => new Promise(() => {}))
    const initialProps: { fence: number; items: AgentJournalRenderItem[] } = {
      fence: 1,
      items: []
    }
    const view = renderHook((props) => useCommandHarness(props), { initialProps })

    let first!: ReturnType<typeof view.result.current.run>
    act(() => {
      first = view.result.current.run('clear')
    })
    const operationId = mocks.call.mock.calls[0]![2].envelope.clientOperationId

    view.rerender({ fence: 2, items: [] })
    await expect(first).resolves.toMatchObject({ accepted: false })
    let replay!: ReturnType<typeof view.result.current.run>
    act(() => {
      replay = view.result.current.run('clear')
    })
    expect(mocks.call.mock.calls[1]![2].envelope.clientOperationId).toBe(operationId)

    await act(async () => {
      firstReply.resolve({ ok: true, value: { command: 'clear', state: 'completed' } })
      await Promise.resolve()
      replayReply.resolve({ ok: true, value: { command: 'clear', state: 'unknown' } })
    })
    await expect(replay).resolves.toMatchObject({ accepted: false })

    act(() => {
      void view.result.current.run('clear')
    })
    expect(mocks.call.mock.calls[2]![2].envelope.clientOperationId).toBe(operationId)
    view.unmount()
  })

  it('retires a command when the hook switches sessions at the same fence', async () => {
    mocks.call.mockImplementation(() => new Promise(() => {}))
    const initialProps: {
      fence: number
      items: AgentJournalRenderItem[]
      sessionId: string
    } = { fence: 1, items: [], sessionId: 'session-1' }
    const view = renderHook((props) => useCommandHarness(props), { initialProps })

    let first!: ReturnType<typeof view.result.current.run>
    act(() => {
      first = view.result.current.run('compact')
    })
    const firstOperationId = mocks.call.mock.calls[0]![2].envelope.clientOperationId

    view.rerender({ fence: 1, items: [], sessionId: 'session-2' })
    await expect(first).resolves.toMatchObject({ accepted: false })
    act(() => {
      void view.result.current.run('compact')
    })
    expect(mocks.call.mock.calls[1]![2].envelope.sessionId).toBe('session-2')
    expect(mocks.call.mock.calls[1]![2].envelope.clientOperationId).not.toBe(firstOperationId)
    view.unmount()
  })

  it('retires a command when its runtime target changes at the same session and fence', async () => {
    mocks.call.mockImplementation(() => new Promise(() => {}))
    const initialProps: {
      fence: number
      items: AgentJournalRenderItem[]
      target: RuntimeClientTarget
    } = { fence: 1, items: [], target: LOCAL_TARGET }
    const view = renderHook((props) => useCommandHarness(props), { initialProps })

    let local!: ReturnType<typeof view.result.current.run>
    act(() => {
      local = view.result.current.run('compact')
    })
    const localOperationId = mocks.call.mock.calls[0]![2].envelope.clientOperationId

    view.rerender({
      fence: 1,
      items: [],
      target: { kind: 'environment', environmentId: 'environment-a' }
    })
    await expect(local).resolves.toMatchObject({ accepted: false })
    act(() => {
      void view.result.current.run('compact')
    })
    const environmentAOperationId = mocks.call.mock.calls[1]![2].envelope.clientOperationId
    expect(mocks.call.mock.calls[1]![0]).toEqual({
      kind: 'environment',
      environmentId: 'environment-a'
    })
    expect(environmentAOperationId).not.toBe(localOperationId)

    view.rerender({
      fence: 1,
      items: [],
      target: { kind: 'environment', environmentId: 'environment-b' }
    })
    act(() => {
      void view.result.current.run('compact')
    })
    expect(mocks.call.mock.calls[2]![0]).toEqual({
      kind: 'environment',
      environmentId: 'environment-b'
    })
    expect(mocks.call.mock.calls[2]![2].envelope.clientOperationId).not.toBe(
      environmentAOperationId
    )
    view.unmount()
  })

  it('ignores a late transport error after switching sessions at the same fence', async () => {
    let reject!: (error: Error) => void
    mocks.call.mockImplementation(
      () =>
        new Promise((_resolve, rejectCall) => {
          reject = rejectCall
        })
    )
    const initialProps: {
      fence: number
      items: AgentJournalRenderItem[]
      sessionId: string
    } = { fence: 1, items: [], sessionId: 'session-1' }
    const view = renderHook((props) => useCommandHarness(props), { initialProps })

    let first!: ReturnType<typeof view.result.current.run>
    act(() => {
      first = view.result.current.run('compact')
    })
    view.rerender({ fence: 1, items: [], sessionId: 'session-2' })
    await expect(first).resolves.toMatchObject({ accepted: false })

    await act(async () => {
      reject(new Error('old session disconnected'))
      await Promise.resolve()
    })
    expect(view.result.current.writeError).toBeNull()
  })

  it('uses a fresh identity after a reply settles an expired claim', async () => {
    vi.useFakeTimers()
    try {
      const firstReply = Promise.withResolvers<unknown>()
      mocks.call
        .mockReturnValueOnce(firstReply.promise)
        .mockImplementation(() => new Promise(() => {}))
      const view = renderHook(() => useCommandHarness({ fence: 1, items: [] }))

      let first!: ReturnType<typeof view.result.current.run>
      act(() => {
        first = view.result.current.run('compact')
      })
      const firstOperationId = mocks.call.mock.calls[0]![2].envelope.clientOperationId
      await act(() => vi.advanceTimersByTimeAsync(CONVERSATION_COMMAND_DEADLINE_MS + 1))
      await expect(first).resolves.toMatchObject({ accepted: false })

      await act(async () => {
        firstReply.resolve({ ok: true, value: { command: 'compact', state: 'completed' } })
        await Promise.resolve()
      })
      act(() => {
        void view.result.current.run('compact')
      })
      expect(mocks.call.mock.calls[1]![2].envelope.clientOperationId).not.toBe(firstOperationId)
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays an expired command with the same identity', async () => {
    vi.useFakeTimers()
    try {
      mocks.call
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({
          ok: true,
          value: { command: 'compact', state: 'completed' }
        })
      const view = renderHook(() => useCommandHarness({ fence: 1, items: [] }))

      let first!: ReturnType<typeof view.result.current.run>
      act(() => {
        first = view.result.current.run('compact')
      })
      const operationId = mocks.call.mock.calls[0]![2].envelope.clientOperationId
      await act(() => vi.advanceTimersByTimeAsync(CONVERSATION_COMMAND_DEADLINE_MS + 1))
      await expect(first).resolves.toMatchObject({ accepted: false })

      await act(async () => {
        await view.result.current.run('compact')
      })
      expect(mocks.call.mock.calls[1]![2].envelope.clientOperationId).toBe(operationId)
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires a definitively refused command identity before retry', async () => {
    mocks.call
      .mockResolvedValueOnce({
        ok: false,
        refusal: {
          code: 'agent_session_operation_invalid',
          message: 'Wait for pending work.'
        }
      })
      .mockImplementation(() => new Promise(() => {}))
    const view = renderHook(() => useCommandHarness({ fence: 1, items: [] }))

    let refusal!: Awaited<ReturnType<typeof view.result.current.run>>
    await act(async () => {
      refusal = await view.result.current.run('compact')
    })
    expect(refusal).toEqual({ accepted: false, error: 'Wait for pending work.' })
    const refusedOperationId = mocks.call.mock.calls[0]![2].envelope.clientOperationId

    act(() => {
      void view.result.current.run('compact')
    })
    expect(mocks.call.mock.calls[1]![2].envelope.clientOperationId).not.toBe(refusedOperationId)
    view.unmount()
  })

  it('retires a completed clear and gives the next command a fresh identity', async () => {
    mocks.call
      .mockResolvedValueOnce({ ok: true, value: { command: 'clear', state: 'completed' } })
      .mockImplementation(() => new Promise(() => {}))
    const view = renderHook(() => useCommandHarness({ fence: 1, items: [] }))

    await act(async () => {
      await view.result.current.run('clear')
    })
    const firstOperationId = mocks.call.mock.calls[0]![2].envelope.clientOperationId

    let second!: ReturnType<typeof view.result.current.run>
    act(() => {
      second = view.result.current.run('clear')
    })
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(mocks.call.mock.calls[1]![2].envelope.clientOperationId).not.toBe(firstOperationId)

    act(() => view.unmount())
    await second
  })

  it('clears a late transport error after the journal already settled the command', async () => {
    let reject!: (error: Error) => void
    mocks.call.mockImplementation(
      () =>
        new Promise((_resolve, rejectCall) => {
          reject = rejectCall
        })
    )
    const initialProps: { fence: number; items: AgentJournalRenderItem[] } = {
      fence: 1,
      items: []
    }
    const view = renderHook((props) => useCommandHarness(props), { initialProps })

    let pending!: ReturnType<typeof view.result.current.run>
    act(() => {
      pending = view.result.current.run('compact')
    })
    const operationId = mocks.call.mock.calls[0]![2].envelope.clientOperationId
    view.rerender({ fence: 1, items: [completedCompact(operationId)] })

    await expect(pending).resolves.toEqual({ accepted: true, error: null })
    await act(async () => {
      reject(new Error('connection lost'))
      await Promise.resolve()
    })
    await waitFor(() => expect(view.result.current.writeError).toBeNull())
  })

  it('does not clear an error owned by a different mutation', async () => {
    let resolveCommand!: (value: unknown) => void
    mocks.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.conversationCommand') {
        return new Promise((resolve) => {
          resolveCommand = resolve
        })
      }
      return Promise.reject(new Error('option failed'))
    })
    const initialProps: { fence: number; items: AgentJournalRenderItem[] } = {
      fence: 1,
      items: []
    }
    const view = renderHook((props) => useCommandHarness(props), { initialProps })

    let pending!: ReturnType<typeof view.result.current.run>
    act(() => {
      pending = view.result.current.run('compact')
    })
    const operationId = mocks.call.mock.calls[0]![2].envelope.clientOperationId
    await act(async () => {
      await view.result.current.mutate('agentSession.setOption', 'agentSession.setOption', {
        key: 'effort',
        value: 'high'
      })
    })
    expect(view.result.current.writeError).toBe('option failed')

    view.rerender({ fence: 1, items: [completedCompact(operationId)] })
    await expect(pending).resolves.toEqual({ accepted: true, error: null })
    expect(view.result.current.writeError).toBe('option failed')

    await act(async () => {
      resolveCommand({ ok: true, value: { command: 'compact', state: 'completed' } })
      await Promise.resolve()
    })
    expect(view.result.current.writeError).toBe('option failed')
  })
})
