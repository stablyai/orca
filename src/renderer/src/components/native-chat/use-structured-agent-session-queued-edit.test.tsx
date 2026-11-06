// @vitest-environment happy-dom
import {
  script,
  rpc,
  HELD,
  SESSION,
  SCOPE,
  message,
  harness,
  begin,
  holdCalls,
  done,
  withText,
  submittedAs,
  writeSpy,
  type Outcome
} from './structured-queued-edit.test-fixture'
import { act, waitFor } from '@testing-library/react'

import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { agentSessionSendBodyFingerprint } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentSessionQueuedMessageEditHoldResult } from '../../../../shared/agent-session/requests/agent-session-queued-message-wire'

import {
  appendNativeChatAttachmentCache,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
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

  it('a card sent elsewhere moves dirty typing into the chat box, after its draft, with one toast', async () => {
    writeNativeChatDraftCache(SCOPE, 'existing')
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('unsaved'))
    hook.rerender({ messages: [] })
    expect(hook.result.current.editor).toBeUndefined()
    expect(readNativeChatDraftCache(SCOPE)).toBe('existing\n\nunsaved')
    expect(toast.error).toHaveBeenCalledTimes(1)
    hook.rerender({ messages: [] })
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('a clean edit whose card leaves just closes; an unloaded list proves nothing', async () => {
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('typing'))
    hook.rerender({ messages: null })
    expect(hook.result.current.editor?.text).toBe('typing')
    act(() => hook.result.current.editor?.change('original'))
    hook.rerender({ messages: [] })
    expect(hook.result.current.editor).toBeUndefined()
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('changed puts the typing in the chat box and reopens on the newer text once it shows', async () => {
    writeNativeChatDraftCache(SCOPE, 'existing')
    script.answer = done({ status: 'changed', messageId: 'card' })
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('local'))
    act(() => hook.result.current.editor?.save())
    await waitFor(() => expect(hook.result.current.editor).toBeUndefined())
    expect(readNativeChatDraftCache(SCOPE)).toBe('existing\n\nlocal')
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'This message changed while you were editing. Your edit is in the chat box.'
    )
    // The newer text has not reached this pane yet: nothing opens on the old one.
    hook.rerender({ messages: [message] })
    expect(hook.result.current.editor).toBeUndefined()
    const remote = withText('remote')
    hook.rerender({ messages: [remote] })
    await waitFor(() => expect(hook.result.current.editor).toMatchObject({ text: 'remote' }))
    expect(holdCalls('acquire')[1]?.[2]).toMatchObject({
      expectedBodyFingerprint: agentSessionSendBodyFingerprint(SESSION, remote.body)
    })
    expect(writeSpy).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledOnce()
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

  it('a refused Save says why once and keeps the editor', async () => {
    script.answer = async () => ({
      kind: 'not-done',
      notice: 'Too much text is waiting in the queue.',
      failure: { kind: 'failed' }
    })
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('long'))
    act(() => hook.result.current.editor?.save())
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Too much text is waiting in the queue.')
    )
    expect(hook.result.current.editor).toMatchObject({ text: 'long', saving: false })
  })

  it('Save answering gone puts the typing in the chat box; another chat keeps it there once', async () => {
    script.answer = done({ status: 'gone', messageId: 'card', disposition: 'dispatched' })
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('unsaved'))
    act(() => hook.result.current.editor?.save())
    await waitFor(() => expect(hook.result.current.editor).toBeUndefined())
    expect(readNativeChatDraftCache(SCOPE)).toBe('unsaved')
    expect(toast.error).toHaveBeenCalledOnce()
    await begin(hook)
    act(() => hook.result.current.editor?.change('another draft'))
    hook.rerender({ messages: [message], sessionId: 'another-session' })
    expect(hook.result.current.editor).toBeUndefined()
    expect(readNativeChatDraftCache(SCOPE)).toBe('unsaved\n\nanother draft')
    expect(toast.error).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(holdCalls('release')).toHaveLength(2))
  })

  it('closing the pane keeps unsaved typing in the chat box; clean edits leave nothing', async () => {
    const dirty = harness()
    await begin(dirty)
    act(() => dirty.result.current.editor?.change('unsaved'))
    dirty.unmount()
    expect(readNativeChatDraftCache(SCOPE)).toBe('unsaved')
    const clean = harness()
    await begin(clean)
    clean.unmount()
    expect(readNativeChatDraftCache(SCOPE)).toBe('unsaved')
    expect(toast.error).toHaveBeenCalledOnce()
    await waitFor(() => expect(holdCalls('release')).toHaveLength(2))
  })

  it('a reload, which unmounts nothing, keeps unsaved typing in the chat box once', async () => {
    writeNativeChatDraftCache(SCOPE, 'existing')
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.change('unsaved'))
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(readNativeChatDraftCache(SCOPE)).toBe('existing\n\nunsaved')
    hook.unmount()
    expect(readNativeChatDraftCache(SCOPE)).toBe('existing\n\nunsaved')
    expect(toast.error).toHaveBeenCalledOnce()
    await waitFor(() => expect(holdCalls('release')).toHaveLength(1))
  })

  describe('a Save whose answer this pane cannot read reads the published card', () => {
    const dropped: () => Promise<Outcome> = async () => ({
      kind: 'not-done',
      notice: 'lost',
      failure: { kind: 'unconfirmed' }
    })
    function deferred() {
      let finish: (outcome: Outcome) => void = () => {}
      script.answer = () =>
        new Promise((resolve) => {
          finish = resolve
        })
      return (outcome: Outcome) => act(async () => finish(outcome))
    }

    it('the card already shows the saved text: the editor closes, quietly', async () => {
      const finish = deferred()
      const hook = harness()
      await begin(hook)
      act(() => hook.result.current.editor?.change('saved'))
      act(() => hook.result.current.editor?.save())
      hook.rerender({ messages: [withText('saved')] })
      await finish({ kind: 'not-done', notice: 'lost', failure: { kind: 'unconfirmed' } })
      expect(hook.result.current.editor).toBeUndefined()
      expect(toast.error).not.toHaveBeenCalled()
      expect(readNativeChatDraftCache(SCOPE)).toBe('')
    })

    it('a lost answer for a Save that landed says nothing either', async () => {
      const finish = deferred()
      const hook = harness(true, { messages: [message], imagesCapable: true })
      await begin(hook)
      act(() =>
        appendNativeChatAttachmentCache(hook.result.current.editor!.draftScopeKey, [
          { id: 'new', path: '/tmp/new.png' }
        ])
      )
      act(() => hook.result.current.editor?.save())
      const saved = withText('original')
      saved.body.blocks.push({ type: 'image-ref', path: '/tmp/new.png' })
      hook.rerender({ messages: [saved], imagesCapable: true })
      await finish({ kind: 'not-done', notice: 'lost', failure: { kind: 'unconfirmed' } })
      expect(hook.result.current.editor).toBeUndefined()
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('the card still shows other text: the editor stays as it was, quietly', async () => {
      script.answer = dropped
      const hook = harness()
      await begin(hook)
      act(() => hook.result.current.editor?.change('typed'))
      act(() => hook.result.current.editor?.save())
      await waitFor(() => expect(hook.result.current.editor?.saving).toBe(false))
      expect(hook.result.current.editor).toMatchObject({ text: 'typed' })
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('an answer that beats its own publication closes once the card shows the saved text, before it drains', async () => {
      script.answer = dropped
      const hook = harness()
      await begin(hook)
      act(() => hook.result.current.editor?.change('saved text'))
      act(() => hook.result.current.editor?.save())
      await waitFor(() => expect(hook.result.current.editor?.saving).toBe(false))
      expect(hook.result.current.editor).toMatchObject({ text: 'saved text' })
      hook.rerender({ messages: [withText('saved text')] })
      expect(hook.result.current.editor).toBeUndefined()
      hook.rerender({ messages: [], submissions: [submittedAs('saved text')] })
      expect(toast.error).not.toHaveBeenCalled()
      expect(readNativeChatDraftCache(SCOPE)).toBe('')
    })

    it('a card that drains with exactly the typed text, unseen, closes quietly too', async () => {
      script.answer = dropped
      const hook = harness()
      await begin(hook)
      act(() => hook.result.current.editor?.change('saved text'))
      act(() => hook.result.current.editor?.save())
      await waitFor(() => expect(hook.result.current.editor?.saving).toBe(false))
      hook.rerender({ messages: [], submissions: [submittedAs('saved text')] })
      expect(hook.result.current.editor).toBeUndefined()
      expect(toast.error).not.toHaveBeenCalled()
      expect(readNativeChatDraftCache(SCOPE)).toBe('')
    })

    it('the card left with its old text (sent elsewhere first): the typing goes to the chat box', async () => {
      const finish = deferred()
      const hook = harness()
      await begin(hook)
      act(() => hook.result.current.editor?.change('typed'))
      act(() => hook.result.current.editor?.save())
      hook.rerender({ messages: [] })
      expect(hook.result.current.editor?.saving).toBe(true)
      await finish({ kind: 'not-done', notice: 'lost', failure: { kind: 'unconfirmed' } })
      expect(hook.result.current.editor).toBeUndefined()
      expect(readNativeChatDraftCache(SCOPE)).toBe('typed')
      expect(toast.error).toHaveBeenCalledOnce()
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
