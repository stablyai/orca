// @vitest-environment happy-dom
import {
  script,
  rpc,
  HELD,
  BASE,
  SESSION,
  SCOPE,
  message,
  harness,
  begin,
  holdCalls,
  done,
  withText,
  submittedAs,
  requestedFingerprint,
  writeSpy,
  write,
  type Outcome
} from './structured-queued-edit.test-fixture'
import { act, render, renderHook, waitFor, within } from '@testing-library/react'
import { createRef } from 'react'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { promptSkillRefs } from './native-chat-prompt-document'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { QueuedEditHostFixtureModule } from '../../../../shared/queued-edit-host.test-fixture'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageEditHoldResult
} from '../../../../shared/agent-session-wire'
import { captureInsertionTarget, insertText } from '../dictation/dictation-insertion-target'
import { useStructuredAgentSessionQueuedEdit } from './use-structured-agent-session-queued-edit'
import { projectQueuedMessageCards } from '../../../../shared/structured-agent-session-queued-cards'
import { useNativeChatComposerEditSession } from './use-native-chat-composer-edit-session'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  appendNativeChatAttachmentCache,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
let queuedMessageUpdateDecision: QueuedEditHostFixtureModule['queuedMessageUpdateDecision']
beforeAll(async () => {
  const fixtures = await vi.importActual<QueuedEditHostFixtureModule>(
    '../../../../main/native-chat/agent-session-journal/queued-edit-host.test-fixture'
  )
  queuedMessageUpdateDecision = fixtures.queuedMessageUpdateDecision
})
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
describe('inline queued editor', () => {
  it('holds the card on its host, saves against the full body, and leaves the chat box alone', async () => {
    writeNativeChatDraftCache(SCOPE, 'existing composer')
    const hook = harness()
    await begin(hook)
    expect(rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'remote-host' },
      'agentSession.queuedMessageEditHold',
      expect.objectContaining({
        sessionId: SESSION,
        action: 'acquire',
        expectedBodyFingerprint: BASE
      })
    )
    expect(hook.result.current.editor).toMatchObject({ text: 'original', acquiring: false })
    act(() => hook.result.current.editor?.change('edited'))
    act(() => hook.result.current.editor?.save())
    await waitFor(() => expect(hook.result.current.editor).toBeUndefined())
    expect(writeSpy).toHaveBeenCalledWith(
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageUpdate',
      { messageId: 'card', expectedBodyFingerprint: BASE, text: 'edited' }
    )
    await waitFor(() => expect(holdCalls('release')).toHaveLength(1))
    expect(holdCalls('release')[0]?.[2].editId).toBe(holdCalls('acquire')[0]?.[2].editId)
    expect(readNativeChatDraftCache(SCOPE)).toBe('existing composer')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a host that cannot edit in place gets no editor and no request', async () => {
    const hook = harness(false)
    await begin(hook)
    expect(hook.result.current.editor).toBeUndefined()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('opens one editor per pane', async () => {
    const second = { ...message, messageId: 'second', position: 3 }
    const hook = harness(true, { messages: [message, second] })
    await begin(hook)
    await act(() => hook.result.current.begin('second'))
    expect(hook.result.current.editor?.messageId).toBe('card')
    expect(holdCalls('acquire')).toHaveLength(1)
  })

  it('Save with the text unchanged writes nothing', async () => {
    const hook = harness()
    await begin(hook)
    act(() => hook.result.current.editor?.save())
    expect(hook.result.current.editor).toBeUndefined()
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it.each(['/model old', '$review old'])(
    'stock Undo restores accepted %s and clean Save; a changed pill uses its actual file',
    async (text) => {
      const skills = text.startsWith('$')
        ? [
            { name: 'review', path: '/A/SKILL.md' },
            { name: 'review', path: '/B/SKILL.md' }
          ]
        : undefined
      const accepted = {
        ...message,
        body: {
          ...message.body,
          blocks: [{ type: 'text' as const, text }],
          ...(skills ? { skills } : {})
        }
      }
      const hook = harness(true, { messages: [accepted], skillsCapable: true })
      const mount = () => {
        const edit = hook.result.current.editor!
        const inputRef = createRef<NativeChatComposerInput>()
        const view = render(
          <NativeChatPromptEditor
            inputRef={inputRef}
            scopeKey={edit.draftScopeKey}
            initialValue={edit.text}
            disabled={false}
            placeholder="Edit message"
            onChange={() => {}}
            onSelect={() => {}}
          />
        )
        return {
          ...view,
          input: inputRef.current!,
          editor: promptEditor(within(view.container).getByRole('textbox'))
        }
      }
      await begin(hook)
      const field = mount()
      act(() => {
        field.input.setSelectionRange(0, text.indexOf(' '))
        expect(field.editor.commands.deleteSelection()).toBe(true)
      })
      expect(field.input.value).toBe(' old')
      await act(async () => {
        expect(field.editor.commands.undo()).toBe(true)
      })
      expect(field.input.value).toBe(text)
      expect(promptSkillRefs(field.editor.getJSON())).toEqual(skills?.slice(0, 1) ?? [])
      act(() => hook.result.current.editor!.save())
      expect(hook.result.current.editor).toBeUndefined()
      expect(writeSpy).not.toHaveBeenCalled()
      field.unmount()
      if (!skills) {
        return
      }

      await begin(hook)
      const changed = mount()
      act(() => {
        changed.input.setSelectionRange(text.length, text.length)
        changed.input.insertText!(' changed')
      })
      act(() => hook.result.current.editor!.save())
      await waitFor(() => expect(hook.result.current.editor).toBeUndefined())
      expect(writeSpy).toHaveBeenCalledExactlyOnceWith(
        'agentSession.queuedMessageUpdate',
        'agentSession.queuedMessageUpdate',
        {
          messageId: 'card',
          expectedBodyFingerprint: agentSessionSendBodyFingerprint(SESSION, accepted.body),
          text: '$review old changed',
          skills: skills.slice(0, 1)
        }
      )
      expect(toast.error).not.toHaveBeenCalled()
    }
  )

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

  it('moves typing into the chat box without image markers, since the card keeps its images', async () => {
    const withImage: AgentSessionQueuedMessage = {
      ...message,
      body: {
        ...message.body,
        blocks: [{ type: 'image-ref', path: '/tmp/a.png' }, ...message.body.blocks]
      }
    }
    const hook = harness(true, { messages: [withImage] })
    await begin(hook)
    act(() => hook.result.current.editor?.change('see [Image #1] not [Image #2]'))
    hook.rerender({ messages: [] })
    expect(readNativeChatDraftCache(SCOPE)).toBe('see not [Image #2]')
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

  it('while a question holds the chat box, the notice says when the edit will be there', async () => {
    script.answer = done({ status: 'gone', messageId: 'card', disposition: 'dispatched' })
    const hook = harness(true, { messages: [message], promptOpen: true })
    await begin(hook)
    act(() => hook.result.current.editor?.change('unsaved'))
    act(() => hook.result.current.editor?.save())
    await waitFor(() => expect(hook.result.current.editor).toBeUndefined())
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'This message was already sent or removed. Your edit will be in the chat box after you answer the agent.'
    )
    expect(readNativeChatDraftCache(SCOPE)).toBe('unsaved')
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

  it('a failed acquire, renewal or release never gates typing, Save or Cancel, and says nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    rpc.mockRejectedValueOnce(new Error('disconnected'))
    const hook = harness()
    await act(async () => {
      await hook.result.current.begin('card')
    })
    expect(hook.result.current.editor?.acquiring).toBe(false)
    act(() => hook.result.current.editor?.change('still typing'))
    // The lease keeps trying on its own beat: acquire again, then renew.
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(holdCalls('acquire')).toHaveLength(2)
    rpc.mockRejectedValueOnce(new Error('renewal failed'))
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(holdCalls('renew')).toHaveLength(1)
    rpc.mockRejectedValueOnce(new Error('release failed'))
    act(() => hook.result.current.editor?.cancel())
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(hook.result.current.editor).toBeUndefined()
    expect(holdCalls('release')).toHaveLength(1)
    await act(() => vi.advanceTimersByTimeAsync(120_000))
    expect(rpc).toHaveBeenCalledTimes(4)
    expect(toast.error).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a lapsed lease is taken again at once for the same text', async () => {
    vi.useFakeTimers()
    const hook = harness()
    await begin(hook)
    rpc.mockResolvedValueOnce({ status: 'expired' })
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(holdCalls('acquire')).toHaveLength(2)
    expect(holdCalls('acquire')[1]?.[2]).toMatchObject({ expectedBodyFingerprint: BASE })
    act(() => hook.result.current.editor?.cancel())
  })

  it('a card edited or sent before the hold lands closes the editor quietly', async () => {
    rpc.mockResolvedValueOnce({ status: 'changed' })
    const hook = harness()
    await begin(hook)
    expect(hook.result.current.editor).toBeUndefined()
    expect(toast.error).not.toHaveBeenCalled()
  })
})

it.each(['updated', 'not-editable', 'clean-gone', 'cancel'] as const)(
  'routes captured real dictation registration across %s',
  async (outcome) => {
    const root = document.createElement('div')
    const field = document.createElement('textarea')
    root.append(field)
    document.body.append(root)
    const hook = renderHook(() => {
      const queued = useStructuredAgentSessionQueuedEdit({
        transport: {
          target: { kind: 'environment', environmentId: 'remote-host' },
          sessionId: SESSION,
          capable: true,
          write
        },
        messages: [message],
        cards: projectQueuedMessageCards([message], [], {}),
        submissions: [],
        composerScopeKey: SCOPE,
        promptOpen: true
      })
      const editor = queued.editor
      useNativeChatComposerEditSession({
        editSession: editor
          ? { save: editor.save, cancel: editor.cancel, canSave: editor.canSave }
          : undefined,
        root: { current: root },
        handle: {
          current: {
            focus: () => true,
            acceptsText: () => !editor?.saving,
            insertTypedText: (text) => {
              if (!editor || editor.saving) {
                return false
              }
              updateNativeChatComposerDraft(
                editor.draftScopeKey,
                { text: readNativeChatComposerDraft(editor.draftScopeKey).text + text },
                'immediate'
              )
              return true
            },
            appendText: () => {},
            contains: () => true,
            handlePasteEvent: () => {},
            pasteFromClipboard: () => {}
          }
        },
        draftScopeKey: editor?.draftScopeKey ?? SCOPE,
        agent: 'codex',
        structuredTransport: undefined,
        sendStructured: () => {},
        ptyCommandRouting: {
          agent: 'codex',
          disabled: false,
          isDispatchingSessionOption: false,
          resolveTarget: () => null,
          sessionOptionsSurface: null,
          trackPendingSend: () => {},
          setDraft: () => {},
          setCaret: () => {},
          setActiveSuggestion: () => {},
          clearSkillOrigin: () => {},
          clearImageAttachments: () => {},
          setNotice: () => {}
        },
        setNotice: () => {},
        disabled: editor?.saving ?? false,
        sendHeld: false,
        sendMessage: () => {},
        completeItem: () => {}
      })
      return queued
    })
    await act(() => hook.result.current.begin('card'))
    field.focus()
    const captured = captureInsertionTarget()
    expect(captured?.kind).toBe('composer')
    if (!captured) {
      throw new Error('missing dictation target')
    }
    if (outcome === 'clean-gone') {
      hook.unmount()
    } else if (outcome === 'cancel') {
      act(() => hook.result.current.editor!.cancel())
    } else {
      let reply: ((value: Outcome) => void) | undefined
      script.answer = () =>
        new Promise((resolve) => {
          reply = resolve
        })
      act(() => hook.result.current.editor!.change('submitted'))
      act(() => hook.result.current.editor!.save())
      act(() => insertText('speech', captured))
      await act(async () =>
        reply!({
          kind: 'done',
          value:
            outcome === 'updated'
              ? { status: outcome, messageId: 'card', fingerprint: requestedFingerprint() }
              : { status: outcome, messageId: 'card' }
        })
      )
      if (outcome === 'not-editable') {
        expect(hook.result.current.editor!.text).toContain('speech')
      }
    }
    act(() => insertText('later', captured))
    if (outcome === 'cancel') {
      expect(readNativeChatDraftCache(SCOPE)).toBe('')
    } else if (outcome === 'clean-gone') {
      expect(readNativeChatDraftCache(SCOPE)).toContain('later')
      expect(readNativeChatDraftCache(SCOPE)).not.toContain('submitted')
    } else {
      expect(hook.result.current.editor!.text).toContain('later')
      expect(readNativeChatDraftCache(SCOPE)).toBe('')
    }
    if (outcome !== 'clean-gone') {
      hook.unmount()
    }
    root.remove()
  }
)

// Real host preflight decides restored-seed CAS; hooks own the resulting action lifetime.
it.each(['refused', 'unknown-committed', 'unknown-refused-unchanged'] as const)(
  'restoring the seed after %s preserves the real uncertainty boundary',
  async (mode) => {
    writeNativeChatDraftCache(SCOPE, 'occupied')
    const hook = harness()
    await begin(hook)
    script.answer =
      mode === 'refused'
        ? done({ status: 'not-editable', messageId: 'card' })
        : async () => ({
            kind: 'not-done',
            notice: 'Unconfirmed',
            failure: { kind: 'unconfirmed' }
          })
    act(() => hook.result.current.editor!.change('attempt'))
    await act(async () => hook.result.current.editor!.save())
    if (mode === 'unknown-refused-unchanged') {
      script.answer = done({ status: 'not-editable', messageId: 'card' })
      act(() => hook.result.current.editor!.change('later refused'))
      await act(async () => hook.result.current.editor!.save())
    }
    act(() => hook.result.current.editor!.change('original'))
    const before = writeSpy.mock.calls.length
    vi.mocked(toast.error).mockClear()
    script.answer = async () => {
      const body = mode === 'unknown-committed' ? withText('attempt').body : message.body
      const result = queuedMessageUpdateDecision(
        {
          messageId: 'card',
          position: 2,
          body,
          fingerprint: agentSessionSendBodyFingerprint(SESSION, body),
          state: 'waiting',
          holdReason: null,
          returnedReason: null,
          returnedRejection: null,
          consumedAs: null,
          queuedAt: null
        },
        SESSION,
        { messageId: 'card', expectedBodyFingerprint: BASE, text: 'original' }
      )
      if (result.status === 'ready') {
        throw new Error('unexpected ready')
      }
      return { kind: 'done', value: result }
    }
    await act(async () => hook.result.current.editor!.save())
    expect(writeSpy).toHaveBeenCalledTimes(before + (mode === 'refused' ? 0 : 1))
    if (mode === 'unknown-refused-unchanged') {
      expect(hook.result.current.editor).toMatchObject({
        text: 'original',
        saving: false,
        canSave: true
      })
      hook.rerender({ messages: [{ ...message }] })
      expect(hook.result.current.editor).toBeDefined()
      expect(readNativeChatDraftCache(SCOPE)).toBe('occupied')
      expect(toast.error).not.toHaveBeenCalled()
    } else if (mode === 'refused') {
      expect(hook.result.current.editor).toBeUndefined()
      expect(readNativeChatDraftCache(SCOPE)).toBe('occupied')
      expect(toast.error).not.toHaveBeenCalled()
    } else {
      expect(hook.result.current.editor).toBeUndefined()
      expect(readNativeChatDraftCache(SCOPE)).toBe('occupied\n\noriginal')
      expect(toast.error).toHaveBeenCalledOnce()
    }
  }
)
