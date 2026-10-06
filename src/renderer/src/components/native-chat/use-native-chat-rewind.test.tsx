// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { AGENT_SESSION_REWIND_REASONS } from '../../../../shared/agent-session-rewind'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../shared/structured-agent-session-reducer'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NATIVE_CHAT_REWIND_RESET_TIMEOUT_MS, useNativeChatRewind } from './use-native-chat-rewind'
import { nativeChatRowOffersRewind } from './native-chat-rewind-eligibility'
import {
  nativeChatRewindPendingCopy,
  nativeChatRewindReasonCopy,
  nativeChatRewindReturnedUnknownCopy,
  nativeChatRewindTimeoutCopy
} from './native-chat-rewind-copy'
import {
  parseAgentSessionWriteFailure,
  type AgentSessionWriteFailure
} from '../../../../shared/agent-session-write-failure'
import { readNativeChatDraftCache, writeNativeChatDraftCache } from './native-chat-draft-cache'

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
  it('confirms without a count, sends, and returns the message', async () => {
    const props = input()
    const onMessageReturned = vi.fn()
    const confirm = vi.fn().mockResolvedValue(true)
    const view = render({ ...props, onMessageReturned })
    await act(() => view.result.current.request('user', confirm))
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Rewind to here?',
        confirmLabel: 'Rewind',
        confirmVariant: 'destructive',
        description: expect.not.stringMatching(/in total/)
      })
    )
    expect(props.send).toHaveBeenCalledWith({ itemId: 'user', expectedEpoch: 'old' })
    expect(readNativeChatDraftCache('pane')).toContain('text of user')
    expect(onMessageReturned).toHaveBeenCalledOnce()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('offers nothing for a row the journal does not hold as a user message', async () => {
    const props = input()
    const confirm = vi.fn()
    const view = render(props)
    await act(() => view.result.current.request('reply', confirm))
    await act(() => view.result.current.request('missing', confirm))
    expect(confirm).not.toHaveBeenCalled()
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
    expect(view.result.current.disabledReason).toBe(nativeChatRewindPendingCopy())
    // The host's latch covers its own in-flight work; it does not relabel ours.
    view.rerender({ ...props, hostBlockedReason: 'outcome-unknown' })
    expect(view.result.current.disabledReason).toBe(nativeChatRewindPendingCopy())
    await act(async () => {
      view.rerender({ ...props, state: { ...props.state, epoch: 'new', items: [] } })
      response.resolve(done)
      await request
    })
    expect(view.result.current.pending).toBe(false)
    expect(view.result.current.blockedRef.current).toBe(false)
  })

  it("lets the host's in-doubt latch disable only the action, never sending", async () => {
    const props: Input = { ...input(), hostBlockedReason: 'outcome-unknown' }
    const view = render(props)
    expect(view.result.current.disabledReason).toBe(nativeChatRewindReasonCopy('outcome-unknown'))
    expect(view.result.current.blockedRef.current).toBe(false)
    expect(view.result.current.pending).toBe(false)
    const run = vi.fn()
    view.result.current.unlessBlocked(run)()
    expect(run).toHaveBeenCalledOnce()
    const confirm = vi.fn()
    await act(() => view.result.current.request('user', confirm))
    expect(confirm).not.toHaveBeenCalled()
    view.rerender({ ...props, hostBlockedReason: undefined })
    expect(view.result.current.disabledReason).toBeNull()
  })

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

  it.each(['busy', 'unwritable', 'loading'] as const)(
    'disables %s sessions with explanatory copy',
    async (mode) => {
      const props = input()
      if (mode === 'busy') {
        props.blocked = true
      }
      if (mode === 'unwritable') {
        props.state.fence = null
      }
      if (mode === 'loading') {
        props.state.status = 'loading'
      }
      const confirm = vi.fn()
      const view = render(props)
      expect(view.result.current.surface).toBeDefined()
      expect(view.result.current.disabledReason).toBeTruthy()
      await act(() => view.result.current.request('user', confirm))
      expect(confirm).not.toHaveBeenCalled()
      expect(props.send).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['unresolved', undefined],
    ['unsupported', { supported: false, reason: 'unsupported' }],
    ['legacy', { supported: false, reason: 'history-not-paginated' }]
  ] as const)('offers no action where support is %s', async (_mode, support) => {
    const props: Input = { ...input(), support }
    const confirm = vi.fn()
    const view = render(props)
    expect(view.result.current.surface).toBeUndefined()
    await act(() => view.result.current.request('user', confirm))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('still offers the action when the options read answered while the host was in doubt', () => {
    const view = render({ ...input(), support: { supported: false, reason: 'outcome-unknown' } })
    expect(view.result.current.surface).toEqual({
      disabledReason: null,
      request: view.result.current.request
    })
  })

  it.each(['epoch', 'messages', 'busy'] as const)(
    'rechecks %s after confirmation and says so once',
    async (change) => {
      const props = input(),
        confirmation = deferred<boolean>()
      const view = render(props)
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
      expect(toastError).toHaveBeenCalledOnce()
      expect(view.result.current.pending).toBe(false)
    }
  )

  it.each(['before', 'after'] as const)(
    'settles when epoch reset arrives %s RPC success',
    async (order) => {
      const props = input(),
        response = deferred<typeof done>()
      props.send.mockReturnValue(response.promise)
      const view = render(props)
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
        response.resolve(done)
        await request
      })
      if (order === 'after') {
        expect(view.result.current.pending).toBe(true)
        expect(view.result.current.blockedRef.current).toBe(true)
        reset()
      }
      expect(view.result.current.pending).toBe(false)
      expect(view.result.current.blockedRef.current).toBe(false)
    }
  )

  it('lets go of a confirmed rewind whose new conversation never arrives, and says so once', async () => {
    vi.useFakeTimers()
    try {
      const props = input()
      const view = render(props)
      await act(() => view.result.current.request('user', async () => true))
      expect(view.result.current.blockedRef.current).toBe(true)
      await act(() => vi.advanceTimersByTimeAsync(NATIVE_CHAT_REWIND_RESET_TIMEOUT_MS - 1))
      expect(view.result.current.pending).toBe(true)
      await act(() => vi.advanceTimersByTimeAsync(1))
      expect(view.result.current.pending).toBe(false)
      expect(view.result.current.blockedRef.current).toBe(false)
      expect(toastError).toHaveBeenCalledExactlyOnceWith(nativeChatRewindTimeoutCopy())
      await act(() => vi.advanceTimersByTimeAsync(NATIVE_CHAT_REWIND_RESET_TIMEOUT_MS))
      expect(toastError).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['hidden throughout', 'hidden part way'] as const)(
    'lets go silently when the pane was %s, since a hidden pane reads nothing',
    async (mode) => {
      vi.useFakeTimers()
      try {
        const props: Input = { ...input(), isVisible: mode !== 'hidden throughout' }
        const view = render(props)
        await act(() => view.result.current.request('user', async () => true))
        expect(view.result.current.blockedRef.current).toBe(true)
        if (mode === 'hidden part way') {
          await act(() => vi.advanceTimersByTimeAsync(1_000))
          view.rerender({ ...props, isVisible: false })
          view.rerender({ ...props, isVisible: true })
        }
        await act(() => vi.advanceTimersByTimeAsync(NATIVE_CHAT_REWIND_RESET_TIMEOUT_MS))
        expect(view.result.current.pending).toBe(false)
        expect(view.result.current.blockedRef.current).toBe(false)
        expect(toastError).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each([...AGENT_SESSION_REWIND_REASONS.filter((r) => r !== 'outcome-unknown'), 'future'])(
    'toasts refusal %s once, unblocks, and keeps the message where it is',
    async (rewindReason) => {
      const props = input()
      props.send.mockResolvedValue(
        notDone(
          // Parsed as a reply is, so a reason this build does not know is dropped.
          parseAgentSessionWriteFailure({
            kind: 'refused',
            code: 'agent_session_operation_invalid',
            details: { reason: 'rewindRefused', rewindReason }
          }) ?? { kind: 'failed' }
        )
      )
      const onMessageReturned = vi.fn()
      const view = render({ ...props, onMessageReturned })
      await act(() => view.result.current.request('user', async () => true))
      expect(toastError).toHaveBeenCalledExactlyOnceWith(nativeChatRewindReasonCopy(rewindReason))
      expect(view.result.current.pending).toBe(false)
      expect(view.result.current.blockedRef.current).toBe(false)
      expect(readNativeChatDraftCache('pane')).toBe('')
      expect(onMessageReturned).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['unconfirmed', { kind: 'unconfirmed' } as const],
    ['operation-unknown', unknownRefusal]
  ])(
    'an unknown outcome (%s) unblocks at once and returns the message',
    async (_label, failure) => {
      const props = input()
      props.send.mockResolvedValue(notDone(failure))
      const onMessageReturned = vi.fn()
      const view = render({ ...props, onMessageReturned })
      await act(() => view.result.current.request('user', async () => true))
      expect(view.result.current.pending).toBe(false)
      expect(view.result.current.blockedRef.current).toBe(false)
      expect(view.result.current.disabledReason).toBeNull()
      expect(readNativeChatDraftCache('pane')).toContain('text of user')
      expect(onMessageReturned).toHaveBeenCalledOnce()
      expect(toastError).toHaveBeenCalledExactlyOnceWith(nativeChatRewindReturnedUnknownCopy())
      expect(nativeChatRewindReturnedUnknownCopy()).not.toContain('blocked')
    }
  )

  it('is not stranded when the host latches and then settles an unknown outcome as refused', async () => {
    const props = input()
    props.send.mockResolvedValue(notDone({ kind: 'unconfirmed' }))
    const view = render(props)
    await act(() => view.result.current.request('user', async () => true))
    view.rerender({ ...props, hostBlockedReason: 'outcome-unknown' })
    expect(view.result.current.blockedRef.current).toBe(false)
    view.rerender({ ...props, hostBlockedReason: undefined })
    expect(view.result.current.blockedRef.current).toBe(false)
    expect(view.result.current.disabledReason).toBeNull()
    const confirm = vi.fn().mockResolvedValue(false)
    await act(() => view.result.current.request('user', confirm))
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('keeps the message when an unknown outcome turns out to have rewound', async () => {
    const props = input()
    props.send.mockResolvedValue(notDone({ kind: 'unconfirmed' }))
    const view = render(props)
    await act(() => view.result.current.request('user', async () => true))
    view.rerender({ ...props, state: { ...props.state, epoch: 'new', items: [] } })
    expect(readNativeChatDraftCache('pane')).toContain('text of user')
  })

  it('says nothing and returns nothing for a reply the pane stopped waiting on', async () => {
    const props = input()
    props.send.mockResolvedValue({ kind: 'dropped' })
    const view = render(props)
    await act(() => view.result.current.request('user', async () => true))
    expect(toastError).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache('pane')).toBe('')
    expect(view.result.current.blockedRef.current).toBe(false)
  })
})

describe('which rows offer rewind', () => {
  const message = (fields: Partial<NativeChatMessage> = {}): NativeChatMessage => ({
    id: 'opener',
    role: 'user',
    blocks: [{ type: 'text', text: 'Prompt' }],
    timestamp: 1,
    source: 'transcript',
    ...fields
  })
  const opens = { depth: 0, turnKey: 'opener' }

  it('offers a sent prompt that opened its own turn', () => {
    expect(nativeChatRowOffersRewind(message(), opens, false)).toBe(true)
  })

  it('offers a prompt whose image is a local file, which can go back to the composer', () => {
    const withFile = message({
      blocks: [
        { type: 'text', text: 'Look' },
        { type: 'image-ref', path: '/tmp/shot.png' }
      ]
    })
    expect(nativeChatRowOffersRewind(withFile, opens, false)).toBe(true)
  })

  it.each([
    ['a steer into a running turn', message(), { depth: 0, turnKey: 'earlier-opener' }, false],
    ['an unsent row', message({ unsent: true }), { depth: 0, turnKey: undefined }, false],
    ['a row with a delivery notice', message(), opens, true],
    ['a queued row', message({ queued: true }), opens, false],
    ['a /compact row', message({ command: { name: 'compact' } }), opens, false],
    ['a goal', message({ sentAs: 'goal' }), opens, false],
    [
      'a prompt with a URL image, which could not go back to the composer',
      message({ blocks: [{ type: 'image-ref', url: 'https://example.com/shot.png' }] }),
      opens,
      false
    ],
    ['a subagent prompt', message(), { depth: 1, turnKey: 'opener' }, false],
    ['an assistant row', message({ role: 'assistant' }), opens, false]
  ] as const)('never offers %s', (_label, row, slot, notice) => {
    expect(nativeChatRowOffersRewind(row, slot, notice)).toBe(false)
  })
})
