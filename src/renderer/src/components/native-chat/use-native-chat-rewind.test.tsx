// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_REWIND_REASONS } from '../../../../shared/agent-session-rewind'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../shared/structured-agent-session-reducer'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { countNativeChatRewindMessages, useNativeChatRewind } from './use-native-chat-rewind'
import { nativeChatRewindReasonCopy } from './native-chat-rewind-copy'

afterEach(cleanup)
const item = (itemId: string, sequence: number, role = 'user'): AgentJournalRenderItem =>
  ({
    itemId,
    sequence,
    revision: 1,
    observedAt: sequence,
    body: { kind: 'message', role, blocks: [{ type: 'text', text: itemId }] }
  }) as AgentJournalRenderItem
function input() {
  return {
    sessionId: 'session',
    state: {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: 'old',
      fence: 1,
      status: 'ready' as const,
      cursor: { epoch: 'old', sequence: 12 },
      items: [item('user', 10), item('reply', 11, 'assistant'), item('later', 12)]
    },
    support: { supported: true as const },
    supportResolved: true,
    blocked: false,
    send: vi.fn().mockResolvedValue({ itemId: 'user', epoch: 'new' })
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('structured chat rewind', () => {
  it('confirms the exact suffix count even when earlier history is unloaded', async () => {
    const props = input()
    props.state.hasOlder = true
    expect(countNativeChatRewindMessages(props.state, 'user')).toBe(3)
    expect(countNativeChatRewindMessages(props.state, 'reply')).toBe(0)
    const confirm = vi.fn().mockResolvedValue(true)
    const view = renderHook(() => useNativeChatRewind(props))
    await act(() => view.result.current.request('user', confirm))
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmVariant: 'destructive',
        description: expect.stringContaining('3 in total')
      })
    )
    expect(props.send).toHaveBeenCalledWith(
      { itemId: 'user', expectedEpoch: 'old' },
      expect.any(Function)
    )
    expect(view.result.current.pending).toBe(true)
    expect(view.result.current.blockedRef.current).toBe(true)
  })

  it('cancels without sending and blocks duplicate clicks while confirming', async () => {
    const props = input(),
      confirmation = deferred<boolean>()
    const confirm = vi.fn(() => confirmation.promise)
    const view = renderHook(() => useNativeChatRewind(props))
    let request!: Promise<void>
    act(() => {
      request = view.result.current.request('user', confirm)
    })
    await act(() => view.result.current.request('user', confirm))
    expect(confirm).toHaveBeenCalledOnce()
    await act(async () => {
      confirmation.resolve(false)
      await request
    })
    expect(props.send).not.toHaveBeenCalled()
    expect(view.result.current.pending).toBe(false)
  })

  it('keeps sending blocked after reopening while the host reports an unresolved rewind', async () => {
    const props: Parameters<typeof useNativeChatRewind>[0] = {
      ...input(),
      hostBlockedReason: 'outcome-unknown'
    }
    const view = renderHook((value) => useNativeChatRewind(value), { initialProps: props })
    expect(view.result.current.error).toContain('may have completed')
    expect(view.result.current.disabledReason).toContain('Sending is blocked')
    expect(view.result.current.blockedRef.current).toBe(true)
    expect(view.result.current.pending).toBe(true)
    const confirm = vi.fn()
    await act(() => view.result.current.request('user', confirm))
    expect(confirm).not.toHaveBeenCalled()
    view.rerender({ ...props, hostBlockedReason: undefined })
    expect(view.result.current.error).toBeNull()
    expect(view.result.current.pending).toBe(false)
    expect(view.result.current.blockedRef.current).toBe(false)
  })

  it('does not label its in-flight request as an unknown outcome when the host prepares recovery', async () => {
    const props = input(),
      response = deferred<{ itemId: string; epoch: string }>()
    props.send.mockReturnValue(response.promise)
    const view = renderHook<
      ReturnType<typeof useNativeChatRewind>,
      Parameters<typeof useNativeChatRewind>[0]
    >((value) => useNativeChatRewind(value), { initialProps: props })
    let request!: Promise<void>
    await act(async () => {
      request = view.result.current.request('user', async () => true)
    })
    view.rerender({ ...props, hostBlockedReason: 'outcome-unknown' })
    expect(view.result.current.pending).toBe(true)
    expect(view.result.current.error).toBeNull()
    await act(async () => {
      response.resolve({ itemId: 'user', epoch: 'new' })
      await request
    })
    expect(view.result.current.error).toBeNull()
    view.rerender({ ...props, state: { ...props.state, epoch: 'new' } })
    expect(view.result.current.pending).toBe(false)
  })

  it('does not execute a confirmation after its pane unmounts', async () => {
    const props = input(),
      confirmation = deferred<boolean>()
    const view = renderHook(() => useNativeChatRewind(props))
    let request!: Promise<void>
    act(() => {
      request = view.result.current.request('user', () => confirmation.promise)
    })
    view.unmount()
    await act(async () => {
      confirmation.resolve(true)
      await request
    })
    expect(props.send).not.toHaveBeenCalled()
  })

  it.each(['busy', 'unwritable', 'handoff', 'legacy', 'loading-support'] as const)(
    'disables %s sessions with explanatory copy',
    async (mode) => {
      const props: Parameters<typeof useNativeChatRewind>[0] = input()
      if (mode === 'loading-support') {
        props.supportResolved = false
      }
      if (mode === 'busy') {
        props.blocked = true
      }
      if (mode === 'unwritable') {
        props.state.fence = null
      }
      if (mode === 'handoff') {
        props.state.handoff = {
          owner: 'tui',
          phase: 'idle',
          stage: null,
          direction: null,
          operationId: null
        }
      }
      if (mode === 'legacy') {
        props.support = { supported: false, reason: 'history-not-paginated' }
      }
      const confirm = vi.fn()
      const view = renderHook(() => useNativeChatRewind(props))
      expect(view.result.current.disabledReason).toBeTruthy()
      if (mode === 'legacy') {
        expect(view.result.current.disabledReason).toContain('older Codex conversation')
      }
      await act(() => view.result.current.request('user', confirm))
      expect(confirm).not.toHaveBeenCalled()
      expect(props.send).not.toHaveBeenCalled()
    }
  )

  it.each(['epoch', 'messages', 'busy'] as const)(
    'rechecks %s after confirmation',
    async (change) => {
      const props = input(),
        confirmation = deferred<boolean>()
      const view = renderHook((value) => useNativeChatRewind(value), { initialProps: props })
      let request!: Promise<void>
      act(() => {
        request = view.result.current.request('user', () => confirmation.promise)
      })
      view.rerender({
        ...props,
        blocked: change === 'busy',
        state: {
          ...props.state,
          epoch: change === 'epoch' ? 'new' : 'old',
          cursor: { epoch: 'old', sequence: change === 'messages' ? 13 : 12 }
        }
      })
      await act(async () => {
        confirmation.resolve(true)
        await request
      })
      expect(props.send).not.toHaveBeenCalled()
      expect(view.result.current.error).toBeTruthy()
    }
  )

  it.each(['before', 'after'] as const)(
    'settles when epoch reset arrives %s RPC success',
    async (order) => {
      const props = input(),
        response = deferred<{ itemId: string; epoch: string }>()
      props.send.mockReturnValue(response.promise)
      const view = renderHook((value) => useNativeChatRewind(value), { initialProps: props })
      let request!: Promise<void>
      await act(async () => {
        request = view.result.current.request('user', async () => true)
      })
      const reset = () =>
        view.rerender({ ...props, state: { ...props.state, epoch: 'new', items: [] } })
      if (order === 'before') {
        reset()
      }
      await act(async () => {
        response.resolve({ itemId: 'user', epoch: 'new' })
        await request
      })
      if (order === 'after') {
        expect(view.result.current.pending).toBe(true)
        reset()
      }
      expect(view.result.current.pending).toBe(false)
      expect(view.result.current.blockedRef.current).toBe(false)
    }
  )

  it.each(AGENT_SESSION_REWIND_REASONS)('explains disabled host support: %s', async (reason) => {
    const props: Parameters<typeof useNativeChatRewind>[0] = {
      ...input(),
      support: { supported: false, reason }
    }
    const view = renderHook(() => useNativeChatRewind(props))
    expect(view.result.current.disabledReason).toBe(nativeChatRewindReasonCopy(reason))
    expect(view.result.current.disabledReason).not.toBe(nativeChatRewindReasonCopy('future-reason'))
    const confirm = vi.fn()
    await act(() => view.result.current.request('user', confirm))
    expect(confirm).not.toHaveBeenCalled()
    expect(props.send).not.toHaveBeenCalled()
  })

  it.each([...AGENT_SESSION_REWIND_REASONS, 'future-reason'])(
    'explains refusal %s',
    async (rewindReason) => {
      const props = input()
      props.send.mockImplementation(async (_fields, failure) => {
        failure({ code: 'agent_session_conflict', rewindReason })
        return null
      })
      const view = renderHook(() => useNativeChatRewind(props))
      await act(() => view.result.current.request('user', async () => true))
      expect(view.result.current.error).toBe(nativeChatRewindReasonCopy(rewindReason))
      if (rewindReason === 'history-limit') {
        expect(view.result.current.error).toContain('Nothing was changed')
      }
      if (rewindReason === 'outcome-unknown') {
        expect(view.result.current.error).toContain('may have completed')
        expect(view.result.current.error).toContain('Sending is blocked')
        expect(view.result.current.error).toContain('until the outcome is resolved')
        expect(view.result.current.error).not.toContain('failed')
        expect(view.result.current.pending).toBe(true)
      }
    }
  )

  it('treats a lost transport response as uncertain and never retries', async () => {
    const props = input()
    props.send.mockImplementation(async (_fields, failure) => {
      failure()
      return null
    })
    const view = renderHook(() => useNativeChatRewind(props))
    await act(() => view.result.current.request('user', async () => true))
    await act(() => view.result.current.request('user', async () => true))
    expect(props.send).toHaveBeenCalledOnce()
    expect(view.result.current.error).toContain('may have completed')
  })
})
