// @vitest-environment happy-dom
import { useLayoutEffect, useRef, useState, useImperativeHandle } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { changePrompt, promptEditor } from './native-chat-prompt-editor.test-support'
import { useNativeChatDraft } from './use-native-chat-draft'
import { promptText, promptSkillRefs } from './native-chat-prompt-document'
import {
  createNativeChatQueuedEditDraft,
  handBackNativeChatQueuedEdit,
  discardNativeChatQueuedEdit
} from './native-chat-queued-edit-draft'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'
import {
  replayNativeChatComposerDraftJournal,
  snapshotNativeChatComposerDraftJournal
} from './native-chat-composer-draft-journal'
import { resolveNativeChatPastedText } from './native-chat-composer-pasted-text-references'
import { nativeChatPastedTextToken } from './native-chat-pasted-text-reference'
import {
  structuredAgentSessionSendBody,
  agentSessionSendBodyFingerprint
} from '../../../../shared/structured-agent-session-send-mutation'

const scope = 'agent-session:rich-return'
let composing = false
function Bottom() {
  const input = useRef<NativeChatComposerInput>(null)
  const draft = useNativeChatDraft(scope, () => composing)
  useLayoutEffect(() => {
    if (!composing && input.current && input.current.value !== draft.draft) {
      input.current.value = draft.draft
    }
  }, [draft.draft])
  const root = useCapturedPrompt(scope, input, draft.setDraft, false)
  return (
    <div ref={root}>
      <NativeChatPromptEditor
        scopeKey={scope}
        inputRef={input}
        initialValue={draft.draft}
        disabled={false}
        placeholder="Bottom"
        onChange={(field) => draft.setDraft(field.value)}
        onSelect={() => {}}
      />
    </div>
  )
}
function returned(text = '$review') {
  const edit = createNativeChatQueuedEditDraft(
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }],
      skills: [{ name: 'review', path: '/returned/SKILL.md' }]
    },
    scope
  )
  updateNativeChatComposerDraft(
    edit.scopeKey,
    {
      text: `${text} changed`,
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'nativeChatSkill', attrs: { token: '$review', path: '/returned/SKILL.md' } },
              { type: 'text', text: ' changed' }
            ]
          }
        ]
      }
    },
    'immediate'
  )
  return edit
}
function nextSend() {
  const draft = readNativeChatComposerDraft(scope)
  return structuredAgentSessionSendBody(
    resolveNativeChatPastedText(scope, draft.text),
    draft.images.map((image) => ({ ...image, previewUri: image.path })),
    promptSkillRefs(draft.document)
  )
}
beforeEach(async () => {
  composing = false
  leaseRpc
    .mockReset()
    .mockImplementation(async (_target, _method, params) =>
      params.action === 'release'
        ? { status: 'released' }
        : { status: 'held', fingerprint: 'fp', leaseDurationMs: 120000, remainingMs: 120000 }
    )
  saveRpc.mockReset()
  localStorage.clear()
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
})

it.each(['/clear', 'typed  \n\n'])(
  'normalizes rich return over %j through the mounted editor and next Send',
  (before) => {
    updateNativeChatComposerDraft(scope, { text: before, images: [] }, 'immediate')
    render(<Bottom />)
    const edit = returned()
    act(() => {
      handBackNativeChatQueuedEdit(edit)
      discardNativeChatQueuedEdit(edit)
    })
    const editor = promptEditor(screen.getByRole('textbox'))
    const expected = before === '/clear' ? '$review changed' : 'typed\n\n$review changed'
    expect(promptText(editor.state.doc)).toBe(expected)
    act(() => editor.commands.insertContentAt(editor.state.doc.content.size - 1, '!'))
    expect(nextSend()).toMatchObject({
      blocks: [{ type: 'text', text: `${expected}!` }],
      skills: [{ name: 'review', path: '/returned/SKILL.md' }]
    })
  }
)

it('keeps equal visible skill tokens with distinct selected paths through return and Send', () => {
  const bottom = createNativeChatQueuedEditDraft(
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: '$review changed' }],
      skills: [{ name: 'review', path: '/bottom/SKILL.md' }]
    },
    'unused'
  )
  updateNativeChatComposerDraft(scope, readNativeChatComposerDraft(bottom.scopeKey), 'immediate')
  render(<Bottom />)
  const edit = returned()
  act(() => {
    handBackNativeChatQueuedEdit(edit)
    discardNativeChatQueuedEdit(edit)
  })
  expect(promptText(promptEditor(screen.getByRole('textbox')).state.doc)).toBe(
    '$review changed\n\n$review changed'
  )
  expect(nextSend().skills).toEqual([
    { name: 'review', path: '/bottom/SKILL.md' },
    { name: 'review', path: '/returned/SKILL.md' }
  ])
  discardNativeChatQueuedEdit(bottom)
})

it('keeps a rich return through an actual composing editor transaction and next Send', () => {
  updateNativeChatComposerDraft(scope, { text: 'typed', images: [] }, 'immediate')
  render(<Bottom />)
  const editor = promptEditor(screen.getByRole('textbox'))
  composing = true
  const edit = returned()
  act(() => {
    handBackNativeChatQueuedEdit(edit)
    discardNativeChatQueuedEdit(edit)
  })
  expect(promptText(editor.state.doc)).toBe('typed')
  act(() =>
    editor.view.dispatch(editor.state.tr.insertText('가', editor.state.doc.content.size - 1))
  )
  expect(readNativeChatComposerDraft(scope).text).toBe('typed가\n\n$review changed')
  expect(nextSend().skills).toEqual([{ name: 'review', path: '/returned/SKILL.md' }])
})

it('replays a full rich addition into existing content, renders it and sends resolved files/images/skills', () => {
  const edit = returned()
  const paste = 'd851d135-98ac-44d1-b122-caf190002345'
  const draft = readNativeChatComposerDraft(edit.scopeKey)
  updateNativeChatComposerDraft(
    edit.scopeKey,
    {
      text: `${draft.text}\n${nativeChatPastedTextToken(paste)}`,
      document: {
        ...draft.document,
        content: [
          ...(draft.document?.content ?? []),
          {
            type: 'paragraph',
            content: [
              {
                type: 'nativeChatFileReference',
                attrs: { token: nativeChatPastedTextToken(paste), path: '' }
              }
            ]
          }
        ]
      },
      pastedTextFiles: { [paste]: '/remote/paste.txt' },
      images: [{ id: 'new', path: '/new.png' }]
    },
    'immediate'
  )
  handBackNativeChatQueuedEdit(edit)
  discardNativeChatQueuedEdit(edit)
  // Simulate another renderer run reading the actual addition journal before storage confirmation.
  const raw = localStorage.getItem('orca:nativeChatComposerDraftJournal:v1')!
  localStorage.setItem(
    'orca:nativeChatComposerDraftJournal:v1',
    raw.replaceAll(/"run":"[^"]+"/g, '"run":"previous-run"')
  )
  const loaded = new Map<string, StoredNativeChatComposerDraft | null>([
    [scope, { text: 'existing', images: [], savedAt: 0 }]
  ])
  replayNativeChatComposerDraftJournal(loaded, snapshotNativeChatComposerDraftJournal())
  updateNativeChatComposerDraft(scope, loaded.get(scope)!, 'immediate')
  render(<Bottom />)
  expect(promptSkillRefs(promptEditor(screen.getByRole('textbox')).getJSON())).toEqual([
    { name: 'review', path: '/returned/SKILL.md' }
  ])
  expect(nextSend()).toMatchObject({
    blocks: [
      { type: 'text', text: expect.stringContaining('@/remote/paste.txt') },
      { type: 'image-ref', path: '/new.png' }
    ],
    skills: [{ name: 'review', path: '/returned/SKILL.md' }]
  })
})

// Joined replacement boundary: real edit owner, picker, mounted rich editor and wire serializer.
const leaseRpc = vi.hoisted(() =>
  vi.fn(
    async (
      _target: unknown,
      _method: string,
      _params: AgentSessionQueuedMessageEditHoldParams
    ): Promise<AgentSessionQueuedMessageEditHoldResult> => ({
      status: 'held',
      fingerprint: 'fp',
      leaseDurationMs: 120000,
      remainingMs: 120000
    })
  )
)
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: leaseRpc
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], retry: () => {} })
}))
import { useStructuredAgentSessionQueuedEdit } from './use-structured-agent-session-queued-edit'
import { projectQueuedMessageCards } from '../../../../shared/structured-agent-session-queued-cards'
import { useNativeChatPickerState } from './use-native-chat-picker-state'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageEditHoldParams,
  AgentSessionQueuedMessageEditHoldResult
} from '../../../../shared/agent-session-wire'
import { queuedMessageWithEdit } from '../../../../shared/queued-message-edit'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'
let controller: ReturnType<typeof useStructuredAgentSessionQueuedEdit>
let picker: ReturnType<typeof useNativeChatPickerState>
const saveRpc = vi.fn()
const joinedWrite: StructuredAgentSessionWrite = saveRpc
function InlineField({ scopeKey }: { scopeKey: string }) {
  const input = useRef<NativeChatComposerInput>(null)
  const draft = useNativeChatDraft(scopeKey, () => false)
  const [caret, setCaret] = useState(draft.draft.length)
  const [, setActiveSuggestion] = useState(0)
  picker = useNativeChatPickerState({
    agent: 'codex',
    terminalTabId: 'inline',
    draftScopeKey: scopeKey,
    draft: draft.draft,
    caret,
    agentCommands: [],
    recalledFromHistory: false,
    disabled: false,
    isComposing: () => false,
    sessionSkills: [{ name: 'review', path: '/B/SKILL.md' }],
    textareaRef: input,
    setDraft: draft.setDraft,
    setCaret,
    setActiveSuggestion
  })
  const root = useCapturedPrompt(scopeKey, input, draft.setDraft, true)
  return (
    <div ref={root}>
      <NativeChatPromptEditor
        scopeKey={scopeKey}
        inputRef={input}
        initialValue={draft.draft}
        disabled={false}
        placeholder="Inline"
        onChange={(field) => {
          draft.setDraft(field.value)
          setCaret(field.value.length)
        }}
        onSelect={(field) => setCaret(field.selectionStart ?? field.value.length)}
      />
    </div>
  )
}
function JoinedEdit({ messages }: { messages: AgentSessionQueuedMessage[] }) {
  controller = useStructuredAgentSessionQueuedEdit({
    transport: {
      target: { kind: 'local' },
      sessionId: 'joined',
      capable: true,
      imagesCapable: true,
      skillsCapable: true,
      write: joinedWrite
    },
    messages,
    cards: projectQueuedMessageCards(messages, [], {}),
    submissions: [],
    composerScopeKey: scope,
    promptOpen: true
  })
  return controller.editor ? (
    <InlineField key={controller.editor.draftScopeKey} scopeKey={controller.editor.draftScopeKey} />
  ) : null
}
it('retains re-picked rich identity after unknown proof and saves the whole replacement against its proven base', async () => {
  leaseRpc.mockClear()
  const original: AgentSessionQueuedMessage = {
    messageId: 'joined-card',
    position: 1,
    state: 'waiting',
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: '$review original' }],
      skills: [{ name: 'review', path: '/A/SKILL.md' }]
    }
  }
  updateNativeChatComposerDraft(scope, { text: 'occupied', images: [] }, 'immediate')
  const view = render(
    <>
      <Bottom />
      <JoinedEdit messages={[original]} />
    </>
  )
  await act(() => controller.begin(original.messageId))
  changePrompt(screen.getByRole('textbox', { name: 'Inline' }), '$review')
  const inlineScope = controller.editor!.draftScopeKey
  const captured = queuedMessageWithEdit(original.body, {
    text: '$review',
    skills: [{ name: 'review', path: '/A/SKILL.md' }],
    images: []
  })
  if (!captured.ok) {
    throw new Error(captured.reason)
  }
  // setContent intentionally replaced the chip; restore selected A through the existing value store before Save.
  act(() =>
    updateNativeChatComposerDraft(
      inlineScope,
      {
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'nativeChatSkill', attrs: { token: '$review', path: '/A/SKILL.md' } }
              ]
            }
          ]
        }
      },
      'immediate'
    )
  )
  saveRpc.mockResolvedValueOnce({
    kind: 'not-done',
    notice: 'Unknown',
    failure: { kind: 'unconfirmed' }
  })
  act(() => controller.editor!.save())
  await waitFor(() => expect(controller.editor!.saving).toBe(false))
  changePrompt(screen.getByRole('textbox', { name: 'Inline' }), '$rev')
  const item =
    picker.autocomplete.mode === 'slash'
      ? picker.autocomplete.items.find((row) => row.kind === 'skill' && row.path === '/B/SKILL.md')
      : undefined
  expect(item).toBeDefined()
  act(() => picker.completeItem(item!))
  const input = promptEditor(screen.getByRole('textbox', { name: 'Inline' }))
  act(() => input.commands.insertContentAt(input.state.doc.content.size - 1, 'suffix'))
  const paste = 'b851d135-98ac-44d1-b122-caf190002345'
  act(() =>
    updateNativeChatComposerDraft(
      inlineScope,
      {
        images: [{ id: 'new-local', path: '/new.png', connectionId: 'host-a' }],
        pastedTextFiles: { [paste]: '/paste.txt' }
      },
      'immediate'
    )
  )
  const beforeProof = readNativeChatComposerDraft(inlineScope)
  view.rerender(
    <>
      <Bottom />
      <JoinedEdit messages={[{ ...original, body: captured.body }]} />
    </>
  )
  expect(controller.editor).toMatchObject({
    draftScopeKey: inlineScope,
    acquiring: false,
    saving: false
  })
  expect(readNativeChatComposerDraft(inlineScope)).toEqual(beforeProof)
  expect(readNativeChatComposerDraft(scope).text).toBe('occupied')
  expect(promptSkillRefs(input.getJSON())).toEqual([{ name: 'review', path: '/B/SKILL.md' }])
  const acquire = leaseRpc.mock.calls
    .map((call) => call[2])
    .filter((params) => params?.action === 'acquire')
  expect(acquire).toHaveLength(2)
  expect(acquire[1]).toMatchObject({
    expectedBodyFingerprint: agentSessionSendBodyFingerprint('joined', captured.body)
  })
  expect(acquire[1].editId).not.toBe(acquire[0].editId)
  saveRpc.mockResolvedValueOnce({
    kind: 'done',
    value: {
      status: 'updated',
      messageId: original.messageId,
      fingerprint: agentSessionSendBodyFingerprint(
        'joined',
        structuredAgentSessionSendBody(
          '$review suffix',
          [{ path: '/new.png', previewUri: '/new.png' }],
          [{ name: 'review', path: '/B/SKILL.md' }]
        )
      )
    }
  })
  act(() => controller.editor!.save())
  await waitFor(() => expect(controller.editor).toBeUndefined())
  expect(saveRpc.mock.calls.at(-1)?.[2]).toMatchObject({
    expectedBodyFingerprint: agentSessionSendBodyFingerprint('joined', captured.body),
    text: '$review suffix',
    skills: [{ name: 'review', path: '/B/SKILL.md' }],
    images: [{ type: 'image-ref', path: '/new.png' }]
  })
  expect(nextSend().blocks).toEqual([{ type: 'text', text: 'occupied' }])
})

import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'
import { useNativeChatComposerEditSession } from './use-native-chat-composer-edit-session'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import { captureInsertionTarget, insertText } from '../dictation/dictation-insertion-target'
function useCapturedPrompt(
  key: string,
  input: { current: NativeChatComposerInput | null },
  setDraft: (text: string) => void,
  editing: boolean
) {
  const root = useRef<HTMLDivElement>(null)
  const handle = useRef<NativeChatComposerHandle>(null)
  const insertion = useNativeChatTypedInsertion({
    textareaRef: input,
    isComposing: () => composing,
    setDraft,
    setCaret: () => {},
    setActiveSuggestion: () => {}
  })
  useImperativeHandle(handle, () => ({
    ...insertion,
    isComposing: () => composing,
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {}
  }))
  useNativeChatComposerEditSession({
    root,
    handle,
    draftScopeKey: key,
    agent: 'codex',
    editSession: editing ? { save: () => {}, cancel: () => {}, canSave: true } : undefined,
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
    disabled: false,
    sendHeld: false,
    sendMessage: () => {},
    completeItem: () => {}
  })
  return root
}
it.each(['mounted', 'success', 'unmounted', 'ime', 'cancel'] as const)(
  'captured late repeated dictation uses actual rich input/store insertion after %s',
  async (mode) => {
    updateNativeChatComposerDraft(scope, { text: 'first\n\necho', images: [] }, 'immediate')
    const original: AgentSessionQueuedMessage = {
      messageId: 'voice',
      position: 1,
      state: 'waiting',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'seed' }] }
    }
    const view = render(
      <>
        <Bottom />
        <JoinedEdit messages={[original]} />
      </>
    )
    await act(() => controller.begin('voice'))
    screen.getByRole('textbox', { name: 'Inline' }).focus()
    const captured = captureInsertionTarget()
    expect(captured?.kind).toBe('composer')
    if (!captured) {
      throw new Error('missing captured voice')
    }
    if (mode === 'success') {
      changePrompt(screen.getByRole('textbox', { name: 'Inline' }), 'accepted')
      saveRpc.mockResolvedValueOnce({
        kind: 'done',
        value: {
          status: 'updated',
          messageId: 'voice',
          fingerprint: agentSessionSendBodyFingerprint(
            'joined',
            structuredAgentSessionSendBody('accepted', [])
          )
        }
      })
    }
    if (mode === 'cancel') {
      act(() => controller.editor!.cancel())
    } else {
      act(() => controller.editor!.save())
      await waitFor(() => expect(controller.editor).toBeUndefined())
    }
    if (mode === 'unmounted') {
      view.unmount()
    }
    if (mode === 'ime') {
      composing = true
    }
    if (mode === 'mounted' || mode === 'success') {
      const bottom = promptEditor(screen.getByRole('textbox', { name: 'Bottom' }))
      act(() => bottom.commands.setTextSelection(bottom.state.doc.content.size - 1))
    }
    act(() => insertText('echo', captured))
    if (mode === 'ime') {
      const bottom = promptEditor(screen.getByRole('textbox', { name: 'Bottom' }))
      expect(promptText(bottom.state.doc)).toBe('first\n\necho')
      act(() =>
        bottom.view.dispatch(bottom.state.tr.insertText('가', bottom.state.doc.content.size - 1))
      )
      expect(nextSend().blocks).toEqual([{ type: 'text', text: 'first\n\necho가 echo' }])
    } else {
      expect(nextSend().blocks).toEqual([
        {
          type: 'text',
          text:
            mode === 'cancel'
              ? 'first\n\necho'
              : mode === 'mounted' || mode === 'success'
                ? 'first\n\nechoecho'
                : 'first\n\necho echo'
        }
      ])
    }
  }
)

it('returns the complete rebased rich replacement once, excluding exact accepted images but retaining a reused ID with changed payload', async () => {
  const original: AgentSessionQueuedMessage = {
    messageId: 'images',
    position: 1,
    state: 'waiting',
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: '$review original' },
        { type: 'image-ref', path: '/original.png', alt: 'original' }
      ],
      skills: [{ name: 'review', path: '/A/SKILL.md' }]
    }
  }
  updateNativeChatComposerDraft(
    scope,
    { text: 'occupied', images: [{ id: 'bottom', path: '/bottom.png' }] },
    'immediate'
  )
  const view = render(
    <>
      <Bottom />
      <JoinedEdit messages={[original]} />
    </>
  )
  await act(() => controller.begin('images'))
  const key = controller.editor!.draftScopeKey
  act(() =>
    updateNativeChatComposerDraft(
      key,
      {
        text: '$review submitted',
        images: [
          ...readNativeChatComposerDraft(key).images,
          { id: 'uploaded', path: '/accepted.png', connectionId: 'remote' }
        ]
      },
      'immediate'
    )
  )
  const fields = {
    text: '$review submitted',
    skills: [{ name: 'review', path: '/A/SKILL.md' }],
    images: [
      { type: 'image-ref' as const, path: '/original.png', alt: 'original' },
      { type: 'image-ref' as const, path: '/accepted.png' }
    ]
  }
  const accepted = queuedMessageWithEdit(original.body, fields)
  if (!accepted.ok) {
    throw new Error(accepted.reason)
  }
  saveRpc.mockResolvedValueOnce({
    kind: 'not-done',
    notice: 'Unknown',
    failure: { kind: 'unconfirmed' }
  })
  act(() => controller.editor!.save())
  await waitFor(() => expect(controller.editor!.saving).toBe(false))
  changePrompt(screen.getByRole('textbox', { name: 'Inline' }), '$rev')
  const row =
    picker.autocomplete.mode === 'slash'
      ? picker.autocomplete.items.find((entry) => entry.kind === 'skill')
      : undefined
  act(() => picker.completeItem(row!))
  const editor = promptEditor(screen.getByRole('textbox', { name: 'Inline' }))
  act(() => editor.commands.insertContentAt(editor.state.doc.content.size - 1, 'newer'))
  view.rerender(
    <>
      <Bottom />
      <JoinedEdit messages={[{ ...original, body: accepted.body }]} />
    </>
  )
  expect(controller.editor?.draftScopeKey).toBe(key)
  const paste = 'c851d135-98ac-44d1-b122-caf190002345'
  act(() => {
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, [
      { type: 'text', text: ' ' },
      {
        type: 'nativeChatFileReference',
        attrs: { token: nativeChatPastedTextToken(paste), path: '' }
      }
    ])
  })
  act(() => {
    updateNativeChatComposerDraft(
      key,
      {
        pastedTextFiles: { [paste]: '/late-file.txt' },
        images: [
          ...readNativeChatComposerDraft(key).images.filter(({ id }) => id !== 'uploaded'),
          { id: 'uploaded', path: '/changed.png', connectionId: 'other-host' },
          { id: 'new', path: '/unsaved.png' }
        ]
      },
      'immediate'
    )
  })
  view.rerender(
    <>
      <Bottom />
      <JoinedEdit messages={[]} />
    </>
  )
  expect(controller.editor).toBeUndefined()
  expect(nextSend()).toMatchObject({
    blocks: [
      { type: 'text', text: expect.stringContaining('occupied\n\n$review newer @/late-file.txt') },
      { type: 'image-ref', path: '/bottom.png' },
      { type: 'image-ref', path: '/changed.png' },
      { type: 'image-ref', path: '/unsaved.png' }
    ],
    skills: [{ name: 'review', path: '/B/SKILL.md' }]
  })
  const returned = readNativeChatComposerDraft(scope)
  view.rerender(
    <>
      <Bottom />
      <JoinedEdit messages={[]} />
    </>
  )
  expect(readNativeChatComposerDraft(scope)).toEqual(returned)
})

it('replays captured ordinary insertion over late storage hydration without changing recovery-journal format', async () => {
  clearNativeChatComposerDraftsForTests()
  let load: ((drafts: Map<string, StoredNativeChatComposerDraft>) => void) | undefined
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.drafts.set(scope, { text: 'echo', images: [], savedAt: 1 })
  setNativeChatComposerDraftStorageForTests({
    ...storage,
    loadAll: () =>
      new Promise((resolve) => {
        load = resolve
      })
  })
  const loading = hydrateNativeChatComposerDrafts()
  const original: AgentSessionQueuedMessage = {
    messageId: 'hydrate-voice',
    position: 1,
    state: 'waiting',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'seed' }] }
  }
  const view = render(<JoinedEdit messages={[original]} />)
  await act(() => controller.begin(original.messageId))
  screen.getByRole('textbox', { name: 'Inline' }).focus()
  const target = captureInsertionTarget()
  if (!target) {
    throw new Error('missing captured target')
  }
  act(() => controller.editor!.save())
  await waitFor(() => expect(controller.editor).toBeUndefined())
  view.unmount()
  act(() => insertText('echo', target))
  await act(async () => {
    load!(new Map([[scope, { text: 'echo', images: [], savedAt: 1 }]]))
    await loading
  })
  render(<Bottom />)
  expect(nextSend().blocks).toEqual([{ type: 'text', text: 'echo echo' }])
  expect(promptText(promptEditor(screen.getByRole('textbox')).state.doc)).toBe('echo echo')
})

it('a late obsolete reacquisition rejection cannot close a twice-rebased editor or gate its next Save', async () => {
  const original: AgentSessionQueuedMessage = {
    messageId: 'leases',
    position: 1,
    state: 'waiting',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'seed' }] }
  }
  const view = render(<JoinedEdit messages={[original]} />)
  await act(() => controller.begin(original.messageId))
  let obsolete: ((answer: AgentSessionQueuedMessageEditHoldResult) => void) | undefined
  leaseRpc.mockImplementationOnce((_target, _method, params) =>
    params.action === 'acquire'
      ? new Promise((resolve) => {
          obsolete = resolve
        })
      : Promise.resolve({ status: 'released' })
  )
  saveRpc.mockResolvedValue({
    kind: 'not-done',
    notice: 'Unknown',
    failure: { kind: 'unconfirmed' }
  })
  changePrompt(screen.getByRole('textbox'), 'A')
  act(() => controller.editor!.save())
  await waitFor(() => expect(controller.editor!.saving).toBe(false))
  changePrompt(screen.getByRole('textbox'), 'B')
  const a = { ...original, body: structuredAgentSessionSendBody('A', []) }
  view.rerender(<JoinedEdit messages={[a]} />)
  expect(controller.editor).toMatchObject({ acquiring: false, canSave: true })
  act(() => controller.editor!.save())
  await waitFor(() => expect(controller.editor!.saving).toBe(false))
  changePrompt(screen.getByRole('textbox'), 'C')
  view.rerender(
    <JoinedEdit messages={[{ ...original, body: structuredAgentSessionSendBody('B', []) }]} />
  )
  expect(obsolete).toBeDefined()
  await act(async () => obsolete!({ status: 'changed' }))
  expect(controller.editor).toMatchObject({
    text: 'C',
    acquiring: false,
    saving: false,
    canSave: true
  })
  expect(readNativeChatComposerDraft(scope).text).toBe('')
})
