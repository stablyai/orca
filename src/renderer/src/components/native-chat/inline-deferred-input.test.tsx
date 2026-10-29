// @vitest-environment happy-dom
import {
  harness,
  begin,
  script,
  requestedFingerprint,
  SCOPE,
  message
} from './structured-queued-edit.test-fixture'
import { useLayoutEffect, useRef } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { useNativeChatDraft } from './use-native-chat-draft'
import { useNativeChatComposerHandle } from './use-native-chat-composer-handle'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import type {
  NativeChatComposerHandle,
  NativeChatStructuredComposerTransport
} from './native-chat-composer-types'
import { registerNativeChatComposerDestination } from './native-chat-composer-destination'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { promptSkillRefs, promptText } from './native-chat-prompt-document'
import { changePrompt, promptEditor } from './native-chat-prompt-editor.test-support'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import { resolveNativeChatPastedText } from './native-chat-composer-pasted-text-references'
import {
  addNativeChatPendingAttachment,
  settleNativeChatPendingAttachmentReferences,
  clearNativeChatPendingAttachmentsForTests
} from './native-chat-pending-attachment-cache'
import { nativeChatPastedTextOperations } from './native-chat-pasted-text-reference'

const clipboard = vi.hoisted(() => ({ text: vi.fn(), file: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
const handles = new Map<string, NativeChatComposerHandle>()
function Field({ scope, disabled = false }: { scope: string; disabled?: boolean }) {
  const input = useRef<NativeChatComposerInput>(null)
  const handle = useRef<NativeChatComposerHandle>(null)
  const root = useRef<HTMLDivElement>(null)
  const draft = useNativeChatDraft(scope, () => false)
  useLayoutEffect(() => {
    if (input.current && input.current.value !== draft.draft) {
      input.current.value = draft.draft
    }
  }, [draft.draft])
  useNativeChatComposerHandle(handle, {
    textareaRef: input,
    isComposing: () => false,
    setDraft: draft.setDraft,
    setCaret: () => {},
    setActiveSuggestion: () => {},
    attachmentScopeKey: scope,
    targetKey: scope,
    disabled,
    caret: draft.draft.length,
    resolveAttachmentOwner: () => ({ kind: 'local' }),
    attachResolvedPaths: () => {},
    attachCopiedFiles: () => {},
    captureCopiedFiles: () => async () => {},
    beginPendingImageAttachment: () => null,
    resolvePendingImageAttachment: () => {},
    dropPendingImageAttachment: () => {},
    setNotice: () => {},
    pastesInline: () => false,
    pastedTextEditor: () => input.current
  })
  useLayoutEffect(() => {
    handles.set(scope, handle.current!)
    const unregister = registerNativeChatComposerDestination(root.current!, handle, true, scope)
    return () => {
      handles.delete(scope)
      unregister()
    }
  }, [scope])
  return (
    <div ref={root}>
      <NativeChatPromptEditor
        scopeKey={scope}
        inputRef={input}
        initialValue={draft.draft}
        disabled={disabled}
        placeholder={scope}
        onChange={(field) => draft.setDraft(field.value)}
        onSelect={() => {}}
      />
    </div>
  )
}
function send(scope = SCOPE) {
  const draft = readNativeChatComposerDraft(scope)
  return structuredAgentSessionSendBody(
    resolveNativeChatPastedText(scope, draft.text),
    draft.images.map((image) => ({ ...image, previewUri: image.path })),
    promptSkillRefs(draft.document)
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
beforeEach(() => {
  clipboard.text.mockReset()
  clipboard.file.mockReset().mockResolvedValue('/saved/paste.txt')
  clearNativeChatPendingAttachmentsForTests()
  nativeChatPastedTextOperations.clear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        readClipboardText: clipboard.text,
        readClipboardFilePaths: async () => [],
        clipboardHasImage: async () => false,
        savePastedTextAsFile: clipboard.file
      }
    }
  })
})
it.each(['clean', 'success', 'cancel', 'no-field', 'no-field-oversize', 'long'] as const)(
  'native menu clipboard completion after %s uses the current destination and next serializer',
  async (mode) => {
    updateNativeChatComposerDraft(
      SCOPE,
      {
        text:
          mode === 'no-field'
            ? '/clear'
            : mode === 'no-field-oversize'
              ? 'occupied'
              : 'first\n\necho',
        images: []
      },
      'immediate'
    )
    const hook = harness()
    await begin(hook)
    const key = hook.result.current.editor!.draftScopeKey
    const view = render(
      <>
        <Field scope={SCOPE} />
        <Field scope={key} />
      </>
    )
    const read = deferred<string>()
    clipboard.text.mockReturnValueOnce(read.promise)
    act(() => handles.get(key)!.pasteFromClipboard())
    if (mode === 'success') {
      act(() => hook.result.current.editor!.change('accepted'))
      script.answer = async () => ({
        kind: 'done',
        value: {
          status: 'updated',
          messageId: message.messageId,
          fingerprint: requestedFingerprint()
        }
      })
    }
    if (mode === 'cancel') {
      act(() => hook.result.current.editor!.cancel())
    } else {
      act(() => hook.result.current.editor!.save())
      await waitFor(() => expect(hook.result.current.editor).toBeUndefined())
    }
    view.rerender(<Field scope={SCOPE} />)
    const bottom = promptEditor(screen.getByRole('textbox'))
    act(() => bottom.commands.setTextSelection(bottom.state.doc.content.size - 1))
    if (mode.startsWith('no-field')) {
      view.unmount()
    }
    const text =
      mode === 'no-field-oversize'
        ? 'echo\n'.repeat(60000)
        : mode === 'long' || mode === 'no-field'
          ? 'echo\n'.repeat(7000)
          : 'echo\n\necho'
    await act(async () => read.resolve(text))
    expect(clipboard.text).toHaveBeenCalledOnce()
    if (mode === 'long') {
      expect(clipboard.file).toHaveBeenCalledWith({ text })
      await waitFor(() =>
        expect(send().blocks).toEqual([{ type: 'text', text: 'first\n\necho @/saved/paste.txt' }])
      )
      expect(Object.values(readNativeChatComposerDraft(SCOPE).pastedTextFiles ?? {})).toEqual([
        '/saved/paste.txt'
      ])
    } else if (mode === 'no-field-oversize') {
      const transport: NativeChatStructuredComposerTransport = {
        capturePresentation: () => () => true,
        send: vi.fn(() => true),
        dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
        optionsSurface: {
          getSnapshot: () => [],
          setOption: vi.fn(),
          invokeAction: vi.fn(),
          subscribe: () => () => {}
        },
        optionSnapshot: [],
        onError: () => {},
        runtime: 'local',
        sessionId: 's',
        runtimeEnvironmentId: null
      }
      const value = readNativeChatComposerDraft(SCOPE)
      expect(value.text).toBe(`occupied ${text}`)
      expect(await dispatchNativeChatStructuredComposerText(transport, value.text)).toMatchObject({
        accepted: false
      })
      expect(transport.send).not.toHaveBeenCalled()
      expect(readNativeChatComposerDraft(SCOPE)).toEqual(value)
    } else if (mode === 'no-field') {
      expect(clipboard.file).not.toHaveBeenCalled()
      expect(send().blocks).toEqual([{ type: 'text', text: `/clear ${text.trimEnd()}` }])
    } else {
      expect(send().blocks).toEqual([
        { type: 'text', text: mode === 'cancel' ? 'first\n\necho' : 'first\n\nechoecho\n\necho' }
      ])
      expect(promptText(bottom.state.doc)).toBe(readNativeChatComposerDraft(SCOPE).text)
    }
  }
)
it('admitted menu text while a Save disables the mounted field changes complete equality and remains inline', async () => {
  const hook = harness()
  await begin(hook)
  const key = hook.result.current.editor!.draftScopeKey
  const view = render(<Field scope={key} />)
  const read = deferred<string>()
  clipboard.text.mockReturnValueOnce(read.promise)
  act(() => handles.get(key)!.pasteFromClipboard())
  act(() => hook.result.current.editor!.change('accepted'))
  const reply = deferred<Awaited<ReturnType<typeof script.answer>>>()
  script.answer = () => reply.promise
  act(() => hook.result.current.editor!.save())
  const fingerprint = requestedFingerprint()
  view.rerender(<Field scope={key} disabled />)
  await act(async () => read.resolve('echo'))
  expect(readNativeChatComposerDraft(key).text).toBe('accepted echo')
  await act(async () =>
    reply.resolve({ kind: 'done', value: { status: 'updated', messageId: 'card', fingerprint } })
  )
  expect(hook.result.current.editor).toMatchObject({ text: 'accepted echo', saving: false })
  expect(send().blocks).toEqual([])
})
it.each(['/clear', '@/same.txt'] as const)(
  'transferred file completion over %s uses ordinary input once per operation and next Send',
  async (before) => {
    updateNativeChatComposerDraft(SCOPE, { text: before, images: [] }, 'immediate')
    const hook = harness()
    await begin(hook)
    const key = hook.result.current.editor!.draftScopeKey
    const view = render(
      <>
        <Field scope={SCOPE} />
        <Field scope={key} />
      </>
    )
    act(() =>
      addNativeChatPendingAttachment(key, { id: 'file-operation', path: '', pending: true })
    )
    // A clean actual departure transfers the captured operation without copying the seed.
    hook.rerender({ messages: [] })
    expect(hook.result.current.editor).toBeUndefined()
    view.rerender(<Field scope={SCOPE} />)
    changePrompt(screen.getByRole('textbox'), before)
    const editor = promptEditor(screen.getByRole('textbox'))
    act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1))
    act(() =>
      expect(
        settleNativeChatPendingAttachmentReferences(key, [
          { id: 'file-operation', path: '/same.txt' }
        ])
      ).toBe(true)
    )
    expect(
      settleNativeChatPendingAttachmentReferences(key, [
        { id: 'file-operation', path: '/same.txt' }
      ])
    ).toBe(false)
    expect(send().blocks).toEqual([{ type: 'text', text: `${before}@/same.txt` }])
    expect(promptText(editor.state.doc)).toBe(`${before}@/same.txt`)
  }
)
