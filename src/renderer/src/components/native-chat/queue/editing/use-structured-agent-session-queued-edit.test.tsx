// @vitest-environment happy-dom
import {
  script,
  rpc,
  HELD,
  SESSION,
  SCOPE,
  harness,
  begin,
  holdCalls,
  withText,
  submittedAs,
  writeSpy,
  type Outcome
} from './structured-queued-edit.test-fixture'
import { act, waitFor } from '@testing-library/react'

import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { agentSessionSendBodyFingerprint } from '../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentSessionQueuedMessageEditHoldResult } from '../../../../../../shared/agent-session/requests/agent-session-queued-message-wire'

import { readNativeChatDraftCache } from '../../drafts/native-chat-draft-views'
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
describe('inline queued editor', () => {
  it('Cancel during a slow acquire closes at once and releases that edit after it lands', async () => {
    let finish: (value: AgentSessionQueuedMessageEditHoldResult) => void = () => {}
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const hook = harness()
    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = hook.result.current.begin('card')
    })
    expect(hook.result.current.editor?.acquiring).toBe(true)
    act(() => hook.result.current.editor?.cancel())
    expect(hook.result.current.editor).toBeUndefined()
    expect(holdCalls('release')).toHaveLength(0)
    await act(async () => {
      finish(HELD)
      await pending
    })
    await waitFor(() => expect(holdCalls('release')).toHaveLength(1))
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('rebases delayed plain proof without trimming the newer replacement', async () => {
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor!.change('saved'))
    script.answer = async () => ({
      kind: 'not-done',
      notice: 'lost',
      failure: { kind: 'unconfirmed' }
    })
    act(() => hook.result.current.editor!.save())
    await waitFor(() => expect(hook.result.current.editor!.saving).toBe(false))
    act(() => hook.result.current.editor!.change('saved plus unsaved'))
    hook.rerender({ messages: [withText('saved')] })
    expect(hook.result.current.editor).toMatchObject({
      text: 'saved plus unsaved',
      acquiring: false,
      saving: false
    })
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    hook.rerender({ messages: [withText('saved')] })
    expect(hook.result.current.editor!.text).toBe('saved plus unsaved')
    expect(holdCalls('acquire').at(-1)![2]).toMatchObject({
      expectedBodyFingerprint: agentSessionSendBodyFingerprint(SESSION, withText('saved').body)
    })
  })

  it('a Save that lands and then drains reads as success, even with its answer lost', async () => {
    let finish: (outcome: Outcome) => void = () => {}
    script.answer = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('saved text'))
    act(() => hook.result.current.editor?.save())
    hook.rerender({ messages: [], submissions: [submittedAs('saved text')] })
    expect(hook.result.current.editor?.saving).toBe(true)
    await act(async () =>
      finish({ kind: 'not-done', notice: 'lost', failure: { kind: 'unconfirmed' } })
    )
    expect(hook.result.current.editor).toBeUndefined()
    expect(toast.error).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
  })
})
