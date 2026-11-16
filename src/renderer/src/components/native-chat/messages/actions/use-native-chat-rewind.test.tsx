// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, message: vi.fn() } }))

import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'

import { useNativeChatRewind } from './use-native-chat-rewind'

import { writeNativeChatDraftCache } from '../../drafts/native-chat-draft-views'

type Input = Parameters<typeof useNativeChatRewind>[0]

afterEach(cleanup)
beforeEach(() => {
  toastError.mockReset()
  writeNativeChatDraftCache('pane', '')
})
const done = { kind: 'done' as const, value: { itemId: 'user', epoch: 'new' } }
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
})
