// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef, type ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatViewIdentity, retireNativeChatViewState } from './native-chat-view-state-memory'
import { NativeChatQueuedMessageEditor } from './NativeChatQueuedMessageEditor'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import {
  useStructuredAgentSessionQueuedEdit,
  type QueuedMessageInlineEditor
} from './use-structured-agent-session-queued-edit'
import { projectQueuedMessageCards } from './structured-agent-session-queued-cards'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'
import type * as NativeChatAttachmentUpload from './native-chat-attachment-upload'
import type * as I18n from '@/i18n/i18n'
import {
  handOffQueuedEdit,
  queuedEditImageFields,
  type QueuedEditImageState
} from './structured-agent-session-queued-edit-images'
import {
  readNativeChatAttachmentCache,
  readNativeChatDraftCache,
  appendNativeChatAttachmentCache
} from './native-chat-draft-cache'
import { queuedEditInput, queuedEditDirty } from '../../../../shared/queued-message-edit'
import { reserveNativeChatAttachmentChips as reserve } from './native-chat-session-attachment-drop'
import * as ExternalAttachments from './use-native-chat-external-attachments'
import { imageReferenceToken } from '../../../../shared/native-chat-image-reference'
import { handleAppMenuPasteRequest } from '@/lib/app-menu-paste'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import { routeNativeChatRootKeyToInput } from './native-chat-root-key-routing'
import * as OsFileDropOwner from '@/hooks/use-os-file-drop-owner'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

const externalAttachments = ExternalAttachments.useNativeChatExternalAttachments
let chips: Parameters<typeof externalAttachments>[0]['pendingChips']
beforeEach(() => {
  clipboardSave.mockReset().mockResolvedValue({ status: 'saved', tempPath: '/tmp/new.png' })
  vi.spyOn(ExternalAttachments, 'useNativeChatExternalAttachments').mockImplementation((args) => {
    chips = args.pendingChips
    return externalAttachments(args)
  })
})
vi.mock('@/i18n/i18n', async (original) => ({
  ...(await original<typeof I18n>()),
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? '')
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: async (
    _target: unknown,
    _method: string,
    params: { action: string }
  ) =>
    params.action === 'release'
      ? { status: 'released' }
      : {
          status: 'held',
          fingerprint: 'f'.repeat(64),
          leaseDurationMs: 120_000,
          remainingMs: 120_000
        }
}))
vi.mock('../../store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/components/editor/useLocalImageSrc', () => ({ useLocalImageSrc: () => undefined }))
vi.mock('./native-chat-attachment-upload', async (original) => ({
  ...(await original<typeof NativeChatAttachmentUpload>()),
  resolveNativeChatAttachmentOwnerForWorktree: () => ({ kind: 'local' })
}))
const clipboardSave = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'saved', tempPath: '/tmp/new.png' }))
)
vi.mock('./native-chat-clipboard-image-save', () => ({
  ownerAcceptsClipboardImage: () => true,
  saveNativeChatPastedClipboardImage: clipboardSave
}))
afterEach(cleanup)
function editor(): QueuedMessageInlineEditor {
  return {
    messageId: 'mail',
    text: 'full message',
    acquiring: false,
    saving: false,
    canSave: true,
    change: vi.fn(),
    save: vi.fn(),
    cancel: vi.fn()
  }
}
function view(
  edit: QueuedMessageInlineEditor,
  prompt: 'question' | 'approval' | null,
  answer = vi.fn(),
  promptCancel = vi.fn()
) {
  return (
    <div data-native-chat-root="true">
      <ul>
        <li>
          <NativeChatQueuedMessageEditor editor={edit} />
        </li>
      </ul>
      {prompt === 'approval' ? (
        <NativeChatApprovalCard
          approval={{
            title: 'Allow command?',
            options: [{ label: 'Allow', send: 'allow' }]
          }}
          onChoose={answer}
          onCancel={promptCancel}
          shouldFocus
        />
      ) : null}
      {prompt === 'question' ? (
        <NativeChatQuestionCard
          prompt={{
            questions: [
              {
                question: 'Which?',
                options: [{ label: 'One' }],
                multiSelect: false
              }
            ]
          }}
          onAnswer={answer}
          onCancel={promptCancel}
          shouldFocus
        />
      ) : null}
    </div>
  )
}
describe('queued card textarea', () => {
  it.each(['question', 'approval'] as const)(
    'stays mounted and focused when a %s opens, its keys apart from the prompt',
    (prompt) => {
      const edit = editor()
      const answer = vi.fn()
      const promptCancel = vi.fn()
      const { rerender } = render(view({ ...edit, acquiring: true }, null, answer, promptCancel))
      rerender(view(edit, null, answer, promptCancel))
      const field = screen.getByRole('textbox', { name: 'Edit message' })
      expect(document.activeElement).toBe(field)
      rerender(view(edit, prompt, answer, promptCancel))
      expect(document.activeElement).toBe(field)
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(edit.save).toHaveBeenCalledOnce()
      expect(answer).not.toHaveBeenCalled()
      fireEvent.keyDown(field, { key: 'Escape' })
      expect(edit.cancel).toHaveBeenCalledOnce()
      expect(promptCancel).not.toHaveBeenCalled()
    }
  )
  it.each(['question', 'approval'] as const)(
    'focuses and saves with a %s already open',
    (prompt) => {
      const edit = editor()
      const { rerender } = render(view({ ...edit, acquiring: true }, prompt))
      rerender(view(edit, prompt))
      const field = screen.getByRole('textbox', { name: 'Edit message' })
      expect(document.activeElement).toBe(field)
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(edit.save).toHaveBeenCalledOnce()
    }
  )
  it('Enter and the platform modifier save, Shift+Enter is a newline and handled keys do not bubble', () => {
    const edit = editor()
    const parent = vi.fn()
    render(
      <div onKeyDown={parent}>
        <NativeChatQueuedMessageEditor editor={edit} />
      </div>
    )
    const field = screen.getByRole('textbox')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(edit.save).toHaveBeenCalledOnce()
    expect(parent).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    expect(edit.save).toHaveBeenCalledOnce()
    for (const [platform, modifier] of [
      ['Macintosh', { metaKey: true }],
      ['Linux', { ctrlKey: true }],
      ['Windows', { ctrlKey: true }]
    ] as const) {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
      fireEvent.keyDown(field, { key: 'Enter', ...modifier })
    }
    expect(edit.save).toHaveBeenCalledTimes(4)
    vi.restoreAllMocks()
  })
  it('IME confirmation and Escape never commit/cancel or reach the prompt', () => {
    const edit = editor()
    const parent = vi.fn()
    render(
      <div onKeyDown={parent}>
        <NativeChatQueuedMessageEditor editor={edit} />
      </div>
    )
    const field = screen.getByRole('textbox')
    fireEvent.compositionStart(field)
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
    fireEvent.compositionEnd(field)
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    expect(edit.save).not.toHaveBeenCalled()
    expect(edit.cancel).not.toHaveBeenCalled()
    expect(parent).not.toHaveBeenCalled()
  })
  it('acquisition seeds a read-only field with the X always usable', () => {
    const edit = { ...editor(), acquiring: true }
    render(<NativeChatQueuedMessageEditor editor={edit} />)
    expect(screen.getByRole('textbox').getAttribute('readonly')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(edit.cancel).toHaveBeenCalledOnce()
  })
  it('the header X cancels and saves nothing; Save is the only footer action', () => {
    const edit = editor()
    render(<NativeChatQueuedMessageEditor editor={edit} />)
    expect(screen.getByText('Editing message')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(edit.cancel).toHaveBeenCalledOnce()
    expect(edit.save).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent)
    ).toEqual(['Cancel editing', 'Save'])
  })
  it.each([
    { state: 'saving', edit: { saving: true } },
    { state: 'unchanged', edit: { canSave: false } }
  ])('Save is disabled while $state and enabled otherwise', ({ edit: overrides }) => {
    const edit = { ...editor(), ...overrides }
    const { rerender } = render(<NativeChatQueuedMessageEditor editor={edit} />)
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.click(save)
    expect(edit.save).not.toHaveBeenCalled()
    rerender(<NativeChatQueuedMessageEditor editor={{ ...edit, saving: false, canSave: true }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(edit.save).toHaveBeenCalledOnce()
  })
  it('Save carries a decorative Enter badge and no key hint text', () => {
    for (const platform of ['Macintosh', 'Windows']) {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
      const { container, unmount } = render(<NativeChatQueuedMessageEditor editor={editor()} />)
      const save = screen.getByRole('button', { name: 'Save' })
      const badge = save.querySelector('[aria-hidden="true"]')
      expect(badge?.querySelector('svg')).toBeTruthy()
      expect(badge?.textContent).toBe('')
      expect(container.textContent).not.toMatch(/Shift|⇧|new line/)
      unmount()
    }
    vi.restoreAllMocks()
  })
})

const card: AgentSessionQueuedMessage = {
  messageId: 'card',
  position: 1,
  state: 'waiting',
  body: {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: 'replace WORD please [Image #1] and [Image #2]' },
      { type: 'image-ref', path: '/host/old.png' },
      { type: 'image-ref', path: '/host/kept.png' }
    ]
  }
}
const writeSpy = vi.fn(async (..._args: unknown[]) => ({
  kind: 'done',
  value: { status: 'updated', messageId: 'card', fingerprint: 'a'.repeat(64) }
}))
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: answers only queuedMessageUpdate, with that method's result.
const write = writeSpy as StructuredAgentSessionWrite

function EditedCard({
  imagesCapable,
  acceptsImages = true,
  runtimeEnvironmentId = null
}: {
  imagesCapable: boolean
  acceptsImages?: boolean
  runtimeEnvironmentId?: string | null
}): React.JSX.Element | null {
  const messages = [card]
  const { editor, begin } = useStructuredAgentSessionQueuedEdit({
    transport: { target: { kind: 'local' }, sessionId: 's', capable: true, imagesCapable, write },
    messages,
    cards: projectQueuedMessageCards(messages, [], {}),
    submissions: [],
    composerScopeKey: 'draft',
    promptOpen: false
  })
  useEffect(() => void begin('card'), [begin])
  const attachTo = {
    terminalTabId: 'tab',
    transport: { sessionId: 's', worktreeId: 'wt', runtimeEnvironmentId, acceptsImages }
  }
  return editor ? (
    <TooltipProvider>
      <ul>
        <li>
          <NativeChatQueuedMessageEditor editor={editor} attachTo={attachTo} images="1 image" />
        </li>
      </ul>
    </TooltipProvider>
  ) : null
}

function savedParams(): unknown {
  return writeSpy.mock.calls.at(-1)?.[2]
}

function PastePane({
  composer,
  children
}: {
  composer: NativeChatComposerHandle
  children: ReactNode
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef(composer)
  useNativeChatPasteBridge({ rootRef, composerRef })
  return (
    <div
      ref={rootRef}
      data-native-chat-root="true"
      onKeyDownCapture={(event) => routeNativeChatRootKeyToInput(event, composer, null)}
    >
      {children}
    </div>
  )
}

describe('queued card image edit', () => {
  it.each([null, 'paired'])(
    'prepares for the captured queued owner %s',
    async (runtimeEnvironmentId) => {
      const owner = vi.spyOn(OsFileDropOwner, 'useOsFileDropOwner')
      try {
        replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 1, pairingRevision: 7 }])
        render(<EditedCard imagesCapable runtimeEnvironmentId={runtimeEnvironmentId} />)
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveProperty('readOnly', false))
        const options = owner.mock.calls.at(-1)![1]
        const destination = options.captureDestination?.(new DragEvent('drop'))
        const consumer =
          typeof options.consumer === 'function' ? options.consumer(destination) : options.consumer
        expect(consumer).toBe(runtimeEnvironmentId ? 'agent' : 'local-chat')
      } finally {
        replaceRuntimeEnvironmentRevisions([])
        owner.mockRestore()
      }
    }
  )

  it.each(['local', 'paired', 'ssh'] as const)(
    'settles an accepted %s image paste while parked, returns the edit and saves once; cancel retires it',
    async (host) => {
      const pending = Promise.withResolvers<{ status: string; tempPath: string }>()
      replaceRuntimeEnvironmentRevisions([{ id: host, createdAt: 1, pairingRevision: 7 }])
      clipboardSave.mockReturnValueOnce(pending.promise)
      writeSpy.mockClear()
      const identity = `queued-paste-${host}`
      const ui = () => (
        <NativeChatViewIdentity.Provider value={identity}>
          <EditedCard imagesCapable runtimeEnvironmentId={host === 'local' ? null : host} />
        </NativeChatViewIdentity.Provider>
      )
      const mounted = render(ui())
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveProperty('readOnly', false))
      const field = screen.getByRole('textbox')
      fireEvent.change(field, { target: { value: 'kept edit' } })
      const data = new DataTransfer()
      data.items.add(new File(['png'], 'image.png', { type: 'image/png' }))
      fireEvent.paste(field, { clipboardData: data })
      expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
      mounted.unmount()
      await act(async () => pending.resolve({ status: 'saved', tempPath: `/host/${host}.png` }))
      const returned = render(ui())
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)
      )
      expect(screen.getByRole('textbox')).toHaveProperty('value', 'kept edit')
      expect(screen.getAllByRole('button', { name: 'Remove attachment' })).toHaveLength(3)
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(writeSpy).toHaveBeenCalledOnce())
      expect(savedParams()).toMatchObject({
        text: expect.stringContaining('kept edit'),
        images: expect.arrayContaining([expect.objectContaining({ path: `/host/${host}.png` })])
      })
      returned.unmount()
      retireNativeChatViewState(identity)

      const cancelled = Promise.withResolvers<{ status: string; tempPath: string }>()
      clipboardSave.mockReturnValueOnce(cancelled.promise)
      const next = render(ui())
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveProperty('readOnly', false))
      fireEvent.paste(screen.getByRole('textbox'), { clipboardData: data })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
      next.unmount()
      await act(async () => cancelled.resolve({ status: 'saved', tempPath: '/host/cancelled.png' }))
      render(ui())
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveProperty('readOnly', false))
      expect(screen.getAllByRole('button', { name: 'Remove attachment' })).toHaveLength(2)
      expect(writeSpy).toHaveBeenCalledOnce()
      retireNativeChatViewState(identity)
      replaceRuntimeEnvironmentRevisions([])
    }
  )

  it('finishes an accepted drop after parking into the queued images and saved text range', async () => {
    const owner = vi.spyOn(OsFileDropOwner, 'useOsFileDropOwner')
    vi.stubGlobal('api', { fs: { stat: async () => ({}) } })
    writeSpy.mockClear()
    const ui = () => (
      <NativeChatViewIdentity.Provider value="queued-drop-return">
        <EditedCard imagesCapable />
      </NativeChatViewIdentity.Provider>
    )
    try {
      const before = render(ui())
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveProperty('readOnly', false))
      const field = screen.getByRole('textbox')
      if (!(field instanceof HTMLTextAreaElement)) {
        throw new Error('Expected queued text field')
      }
      fireEvent.change(field, { target: { value: 'alpha WORD omega' } })
      field.setSelectionRange(6, 10, 'backward')
      fireEvent.select(field)
      const destination = owner.mock.calls.at(-1)![1].captureDestination?.(new DragEvent('drop'))
      if (typeof destination !== 'function') {
        throw new Error('Expected a captured drop destination')
      }
      before.unmount()
      await act(async () => {
        await destination(['/tmp/drop.png', '/repo/notes.txt'])
      })
      render(ui())
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveProperty('readOnly', false))
      expect(screen.getByRole('textbox')).toHaveProperty('value', 'alpha @/repo/notes.txt  omega')
      expect(screen.getAllByRole('button', { name: 'Remove attachment' })).toHaveLength(3)
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(writeSpy).toHaveBeenCalledOnce())
      expect(savedParams()).toMatchObject({
        images: expect.arrayContaining([expect.objectContaining({ path: '/tmp/drop.png' })])
      })
    } finally {
      retireNativeChatViewState('queued-drop-return')
      owner.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('pastes into the owning queued edit through native key and menu delivery', async () => {
    let field: HTMLElement
    const ui = {
      readClipboardText: vi.fn(),
      performNativePaste: vi.fn(() => {
        expect(document.activeElement).toBe(field)
      })
    }
    vi.stubGlobal('api', { ui, fs: { getPathForFile: () => '' } })
    vi.stubGlobal('navigator', { userAgent: 'Windows', clipboard: undefined })
    const composer: NativeChatComposerHandle = {
      focus: vi.fn(() => true),
      insertTypedText: () => true,
      acceptsText: () => true,
      appendText: vi.fn(),
      handlePasteEvent: vi.fn(),
      pasteFromClipboard: vi.fn(),
      contains: () => false
    }
    try {
      render(
        <PastePane composer={composer}>
          <EditedCard imagesCapable />
        </PastePane>
      )
      const attach = await screen.findByRole('button', { name: 'Attach file' })
      field = screen.getByRole('textbox', { name: 'Edit message' })
      await waitFor(() => expect(field).toHaveProperty('readOnly', false))
      attach.focus()
      expect(fireEvent.keyDown(attach, { key: 'v', ctrlKey: true })).toBe(true)
      expect(document.activeElement).toBe(field)
      const data = new DataTransfer()
      data.setData('text/plain', 'pasted text')
      data.items.add(new File(['png'], 'pasted.png', { type: 'image/png' }))
      fireEvent.paste(field, { clipboardData: data })
      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: 'Remove attachment' })).toHaveLength(3)
      )
      expect(field).toHaveProperty('value', expect.stringContaining('pasted text'))
      attach.focus()
      await act(
        async () =>
          void (await handleAppMenuPasteRequest({
            readClipboardText: ui.readClipboardText,
            performNativePaste: ui.performNativePaste
          }))
      )
      expect(ui.performNativePaste).toHaveBeenCalledExactlyOnceWith({ mode: 'paste' })
      expect(ui.readClipboardText).not.toHaveBeenCalled()
      expect(composer.pasteFromClipboard).not.toHaveBeenCalled()
      expect(composer.handlePasteEvent).not.toHaveBeenCalled()
      expect(composer.focus).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('keeps image intake text-neutral, saves suffixes and hands off only surviving changes', async () => {
    writeSpy.mockClear()
    render(<EditedCard imagesCapable />)
    const field = await screen.findByRole('textbox', { name: 'Edit message' })
    await waitFor(() => expect(field.getAttribute('readonly')).toBeNull())
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove attachment' })[0]!)
    // The field shows what the agent will read: the removed image's marker goes, #2 becomes #1.
    expect(field).toHaveProperty('value', 'replace WORD please and [Image #1]')
    const data = new DataTransfer()
    data.setData('text/plain', 'X')
    data.items.add(new File(['png'], 'new.png', { type: 'image/png' }))
    if (!(field instanceof HTMLTextAreaElement)) {
      throw new Error('Expected the edit textarea')
    }
    field.focus()
    field.setSelectionRange(8, 12)
    act(() => {
      const [first, second] = reserve(chips, ['/tmp/first.png', '/tmp/second.png'])
      chips.resolve(second!.chipId, second!.path)
      chips.resolve(first!.chipId, first!.path)
    })
    expect(field.value).toBe('replace WORD please and [Image #1]')
    expect([field.selectionStart, field.selectionEnd]).toEqual([8, 12])
    act(() => {
      field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
    })
    await waitFor(() => expect(field.value).toBe('replace X please and [Image #1]'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false)
    )
    fireEvent.change(field, { target: { value: 'abc def' } })
    field.setSelectionRange(4, 4)
    act(() => {
      const [file, image] = reserve(chips, ['/repo/notes.txt', '/tmp/file.png'])
      chips.resolve(image!.chipId, image!.path)
      chips.attachReferences([{ id: file!.chipId, path: file!.path }])
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove attachment' })[3]!)
    expect(field.value).toBe('abc @/repo/notes.txt def')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(writeSpy).toHaveBeenCalledOnce())
    expect(savedParams()).toMatchObject({
      text: 'abc @/repo/notes.txt def [Image #2] [Image #3] [Image #4] ',
      images: [
        { type: 'image-ref', path: '/host/kept.png' },
        { type: 'image-ref', path: '/tmp/first.png' },
        { type: 'image-ref', path: '/tmp/second.png' },
        { type: 'image-ref', path: '/tmp/file.png' }
      ]
    })
    const edit: QueuedEditImageState = {
      draftKey: 'r6-handoff',
      body: card.body,
      text: ' original  wording\n[Image #1] \n',
      ...queuedEditImageFields(
        card.body,
        () => edit,
        () => true,
        () => {}
      )
    }
    edit.body = { ...card.body, blocks: [{ type: 'text', text: edit.text }] }
    edit.kept = []
    const original = edit.text
    for (const exit of ['pending', 'drop', 'remove'] as const) {
      const pending = edit.intake.begin()!
      if (exit === 'remove') {
        edit.intake.resolve(pending, '/tmp/new.png')
      }
      if (exit !== 'pending') {
        edit.intake[exit](pending)
      }
      expect(edit.text).toBe(original)
      expect(handOffQueuedEdit(edit)).toBe(false)
      expect(readNativeChatDraftCache(edit.draftKey)).toBe('')
      edit.intake.drop(pending)
      expect(queuedEditDirty(edit.body, edit)).toBe(false)
    }
    edit.intake.append(['/tmp/new.png'])
    const moved = edit.added[0]!
    expect(queuedEditInput(edit.body, edit, true)).toEqual(queuedEditInput(edit.body, edit, true))
    expect(edit.text).toBe(original)
    expect(handOffQueuedEdit(edit)).toBe(true)
    expect(readNativeChatAttachmentCache(edit.draftKey)).toEqual([
      { id: moved.id, path: moved.path }
    ])
    expect(readNativeChatDraftCache(edit.draftKey)).toBe(`${imageReferenceToken(moved.id)} `)
    edit.draftKey += '-typed'
    appendNativeChatAttachmentCache(edit.draftKey, [{ id: 'destination', path: '/tmp/dest.png' }])
    edit.kept = [{ id: 'kept', block: { type: 'image-ref', path: '/host/kept.png' } }]
    edit.text = 'typed [Image #1] not [Image #2]'
    expect(handOffQueuedEdit(edit)).toBe(true)
    expect(readNativeChatDraftCache(edit.draftKey)).toBe(
      `typed  not [Image #2] ${imageReferenceToken(moved.id)} `
    )
    expect(readNativeChatAttachmentCache(edit.draftKey).map(({ id }) => id)).toEqual([
      'destination',
      moved.id
    ])
  })

  it('never saves an image change as text alone once the host stops reading as taking images', async () => {
    writeSpy.mockClear()
    const { rerender } = render(<EditedCard imagesCapable />)
    const field = await screen.findByRole('textbox', { name: 'Edit message' })
    await waitFor(() => expect(field.getAttribute('readonly')).toBeNull())
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove attachment' })[0]!)
    rerender(<EditedCard imagesCapable={false} />)
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toHaveProperty('disabled', true)
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('against a host that edits text only, shows the count and saves text alone', async () => {
    writeSpy.mockClear()
    render(<EditedCard imagesCapable={false} />)
    const field = await screen.findByRole('textbox', { name: 'Edit message' })
    await waitFor(() => expect(field.getAttribute('readonly')).toBeNull())
    expect(screen.getByText('1 image')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove attachment' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Attach file' })).toBeNull()
    fireEvent.change(field, { target: { value: 'see that' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(writeSpy).toHaveBeenCalledOnce())
    expect(savedParams()).toEqual({
      messageId: 'card',
      expectedBodyFingerprint: expect.any(String),
      text: 'see that'
    })
  })
})

it('reattaches an acquired edit range without taking sibling focus or scrolling, then honors a fresh Edit acquisition', () => {
  const edit = { ...editor(), selection: { from: 2, to: 7, direction: 'backward' as const } }
  const sibling = document.createElement('textarea')
  document.body.append(sibling)
  sibling.focus()
  const geometry = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      return DOMRect.fromRect({ y: this.tagName === 'LI' ? 400 : 0, height: 100, width: 100 })
    })
  const rendered = render(view(edit, null))
  const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edit message' })
  const list = field.closest('ul')!
  expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([
    2,
    7,
    'backward'
  ])
  expect(document.activeElement).toBe(sibling)
  expect(list.scrollTop).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(edit.save).toHaveBeenCalledOnce()
  rendered.rerender(view({ ...edit, acquiring: true }, null))
  rendered.rerender(view(edit, null))
  expect(document.activeElement).toBe(field)
  expect(list.scrollTop).toBe(400)
  geometry.mockRestore()
  sibling.remove()
})
