// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, message: vi.fn() } }))

import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../../../shared/agent-session/structured-agent-session-reducer'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'

import { AGENT_SESSION_REWIND_RESET_TIMEOUT_MS } from '../../../../../../shared/agent-session/lifecycle/agent-session-rewind-request'
import { useNativeChatRewind } from './use-native-chat-rewind'

import { nativeChatRewindReasonCopy, sayNativeChatRewind } from './native-chat-rewind-copy'
import type { AgentSessionWriteFailure } from '../../../../../../shared/agent-session/failures/agent-session-write-failure'
import {
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from '../../drafts/native-chat-draft-views'

type Input = Parameters<typeof useNativeChatRewind>[0]

afterEach(cleanup)
beforeEach(() => {
  toastError.mockReset()
  writeNativeChatDraftCache('pane', '')
})
const done = { kind: 'done' as const, value: { itemId: 'user', epoch: 'new' } }
const notDone = (failure: AgentSessionWriteFailure) => ({
  kind: 'not-done' as const,
  notice: '',
  failure
})
const unknownRefusal: AgentSessionWriteFailure = {
  kind: 'refused',
  code: 'agent_session_operation_unknown',
  details: { reason: 'rewindUnconfirmed', rewindReason: 'outcome-unknown' }
}
const item = (
  itemId: string,
  sequence: number,
  role: 'user' | 'assistant' = 'user'
): AgentJournalRenderItem => ({
  itemId,
  sequence,
  revision: 1,
  observedAt: sequence,
  body: { kind: 'message', role, blocks: [{ type: 'text', text: `text of ${itemId}` }] }
})
function input(): Input & { send: ReturnType<typeof vi.fn> } {
  return {
    sessionId: 'session',
    capturePresentation: () => () => true,
    composerScopeKey: 'pane',
    state: {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: 'old',
      fence: 1,
      status: 'ready' as const,
      cursor: { epoch: 'old', sequence: 12 },
      items: [item('user', 10), item('reply', 11, 'assistant'), item('later', 12)]
    },
    support: { supported: true as const },
    blocked: false,
    send: vi.fn().mockResolvedValue(done)
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function render(props: Input) {
  return renderHook((value: Input) => useNativeChatRewind(value), { initialProps: props })
}

describe('structured chat rewind', () => {
  it('offers rewind only after the clear, including when its divider is off the loaded page', async () => {
    const props = input()
    const clear = {
      ...item('clear', 11),
      body: {
        kind: 'status' as const,
        text: 'Context cleared',
        contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 1 }
      }
    }
    const view = render({
      ...props,
      state: { ...props.state, items: [item('user', 10), clear, item('later', 12)] }
    })
    expect([...(view.result.current.surface?.eligibleItemIds ?? [])]).toEqual(['later'])
    const confirm = vi.fn().mockResolvedValue(true)
    await act(() => view.result.current.request('user', confirm))
    expect(confirm).not.toHaveBeenCalled()
    view.rerender({ ...props, contextFloor: { epoch: 'old', sequence: 11 } })
    expect([...(view.result.current.surface?.eligibleItemIds ?? [])]).toEqual(['later'])
  })

  it('awaits the suffix sequence in the same epoch before unblocking', async () => {
    const props = input()
    props.send.mockResolvedValue({
      kind: 'done',
      value: { itemId: 'user', epoch: 'old', sequence: 15 }
    })
    const view = render(props)
    await act(() => view.result.current.request('user', vi.fn().mockResolvedValue(true)))
    expect(view.result.current.pending).toBe(true)
    expect(view.result.current.blockedRef.current).toBe(true)
    view.rerender({ ...props, state: { ...props.state, cursor: { epoch: 'old', sequence: 15 } } })
    expect(view.result.current.pending).toBe(false)
    expect(view.result.current.blockedRef.current).toBe(false)
  })

  it('blocks nothing while the confirmation is open, and ignores a second click', async () => {
    const props = input(),
      confirmation = deferred<boolean>()
    const confirm = vi.fn(() => confirmation.promise)
    const view = render(props)
    let request!: Promise<void>
    act(() => {
      request = view.result.current.request('user', confirm)
    })
    expect(view.result.current.pending).toBe(false)
    expect(view.result.current.blockedRef.current).toBe(false)
    await act(() => view.result.current.request('user', confirm))
    expect(confirm).toHaveBeenCalledOnce()
    await act(async () => {
      confirmation.resolve(false)
      await request
    })
    expect(props.send).not.toHaveBeenCalled()
    expect(view.result.current.pending).toBe(false)
  })

  it('blocks only while the confirmed request is in flight', async () => {
    const props = input(),
      response = deferred<typeof done>()
    props.send.mockReturnValue(response.promise)
    const view = render(props)
    let request!: Promise<void>
    await act(async () => {
      request = view.result.current.request('user', async () => true)
    })
    expect(view.result.current.pending).toBe(true)
    expect(view.result.current.blockedRef.current).toBe(true)
    expect(view.result.current.disabledReason).toBe(sayNativeChatRewind('pending'))
    // The host's latch covers its own in-flight work; it does not relabel ours.
    view.rerender({ ...props, hostBlockedReason: 'outcome-unknown' })
    expect(view.result.current.disabledReason).toBe(sayNativeChatRewind('pending'))
    await act(async () => {
      view.rerender({ ...props, state: { ...props.state, epoch: 'new', items: [] } })
      response.resolve(done)
      await request
    })
    expect(view.result.current.pending).toBe(false)
    expect(view.result.current.blockedRef.current).toBe(false)
  })

  it("holds only its own chat's sends when the view moves to another chat mid-rewind", async () => {
    const props = input(),
      response = deferred<typeof done>()
    props.send.mockReturnValue(response.promise)
    const view = render(props)
    let request!: Promise<void>
    await act(async () => {
      request = view.result.current.request('user', async () => true)
    })
    view.rerender({ ...props, sessionId: 'other' })
    expect(view.result.current.disabledReason).toBeNull()
    expect(view.result.current.admitsSend()).toBe(true)
    view.rerender(props)
    expect(view.result.current.admitsSend()).toBe(false)
    await act(async () => {
      view.rerender({ ...props, state: { ...props.state, epoch: 'new', items: [] } })
      response.resolve(done)
      await request
    })
  })

  it("lets the host's in-doubt latch disable only the action, never sending", async () => {
    const props: Input = { ...input(), hostBlockedReason: 'outcome-unknown' }
    const view = render(props)
    expect(view.result.current.disabledReason).toBe(nativeChatRewindReasonCopy('outcome-unknown'))
    expect(view.result.current.blockedRef.current).toBe(false)
    expect(view.result.current.pending).toBe(false)
    expect(view.result.current.admitsSend()).toBe(true)
    const confirm = vi.fn()
    await act(() => view.result.current.request('user', confirm))
    expect(confirm).not.toHaveBeenCalled()
    view.rerender({ ...props, hostBlockedReason: undefined })
    expect(view.result.current.disabledReason).toBeNull()
  })

  it.each([done, notDone(unknownRefusal)])(
    'returns captured content after closure for $kind',
    async (outcome) => {
      const props = input(),
        answer = deferred<typeof outcome>()
      props.send.mockReturnValue(answer.promise)
      const onMessageReturned = vi.fn(),
        view = render({ ...props, onMessageReturned })
      let request!: Promise<void>
      await act(async () => {
        request = view.result.current.request('user', async () => true)
      })
      view.unmount()
      writeNativeChatDraftCache('pane', 'new writing')
      await act(async () => {
        answer.resolve(outcome)
        await request
      })
      expect(readNativeChatDraftCache('pane')).toBe('new writing\n\ntext of user')
      expect(onMessageReturned).not.toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    }
  )

  it('does not execute a confirmation after its pane unmounts', async () => {
    const props = input(),
      confirmation = deferred<boolean>()
    const view = render(props)
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

  it('lets go of a confirmed rewind whose new conversation never arrives, and says so once', async () => {
    vi.useFakeTimers()
    try {
      const props = input()
      const view = render(props)
      await act(() => view.result.current.request('user', async () => true))
      expect(view.result.current.blockedRef.current).toBe(true)
      await act(() => vi.advanceTimersByTimeAsync(AGENT_SESSION_REWIND_RESET_TIMEOUT_MS - 1))
      expect(view.result.current.pending).toBe(true)
      await act(() => vi.advanceTimersByTimeAsync(1))
      expect(view.result.current.pending).toBe(false)
      expect(view.result.current.blockedRef.current).toBe(false)
      expect(toastError).toHaveBeenCalledExactlyOnceWith(sayNativeChatRewind('timeout'))
      await act(() => vi.advanceTimersByTimeAsync(AGENT_SESSION_REWIND_RESET_TIMEOUT_MS))
      expect(toastError).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
