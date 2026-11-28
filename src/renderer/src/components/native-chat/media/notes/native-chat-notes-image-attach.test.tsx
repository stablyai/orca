// @vitest-environment happy-dom
// A marked notes image is attached only to the message box that asked for it.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { toast } from 'sonner'
import { useNativeChatComposerAttachments } from '../../attachments/chips/use-native-chat-composer-attachments'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { useNativeChatComposerPaste } from '../../paste/use-native-chat-composer-paste'
import {
  NativeChatGeneratedImageRefusedError,
  useNativeChatGeneratedImageAttach
} from '../../paste/use-native-chat-generated-image-attach'
import type { NativeChatAttachmentOwner } from '../../attachments/uploads/native-chat-attachment-owner'
import { translate } from '@/i18n/i18n'
import { nativeChatImageOnlyPendingCountForTests } from '../../attachments/chips/use-native-chat-image-only-pending'
import type { NativeChatComposerInput } from '../../composer/editor/native-chat-composer-input'
import {
  nativeChatNotesCloseErrorText,
  nativeChatNotesHandOffErrorText
} from './native-chat-notes-handoff-errors'

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create(() => ({})) }
})

afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const noop = () => {}

function mountComposer(
  scope: string,
  owner: NativeChatAttachmentOwner = { kind: 'local' },
  setNotice: Mock = vi.fn(),
  box: { acceptsImages?: boolean; input?: NativeChatComposerInput } = {}
) {
  const textareaRef = { current: box.input ?? null }
  return renderHook(() => {
    const attachments = useNativeChatComposerAttachments({
      attachmentScopeKey: scope,
      allowWithoutTarget: true,
      acceptsImages: box.acceptsImages ?? true,
      imageReferences: true,
      caret: 0,
      disabled: false,
      isComposing: () => false,
      resolveTarget: () => null,
      textareaRef,
      setCaret: noop,
      setDraft: noop,
      setNotice
    })
    const {
      handlePaste: _paste,
      pasteFromClipboard: _read,
      ...paste
    } = useNativeChatComposerPaste({
      ...attachments,
      attachmentScopeKey: scope,
      targetKey: 'chat',
      disabled: false,
      caret: 0,
      resolveAttachmentOwner: () => owner,
      attachCopiedFiles: noop,
      captureCopiedFiles: () => async () => {},
      insertTypedText: () => false,
      setCaret: noop,
      setNotice
    })
    return useNativeChatGeneratedImageAttach(
      paste,
      () => owner,
      () => textareaRef.current
    )
  })
}

function holdSave() {
  const save = Promise.withResolvers<string>()
  const saveClipboardImageAsTempFile = vi.fn((_args: { png?: Uint8Array }) => save.promise)
  vi.stubGlobal('api', { ui: { saveClipboardImageAsTempFile } })
  return { saveClipboardImageAsTempFile, finish: (path: string) => save.resolve(path) }
}

const image = () => new Blob(['marked'], { type: 'image/png' })

it('a marked image saved while its message box is open joins that message', async () => {
  const scope = 'agent-session:notes-attach-open'
  const composer = mountComposer(scope)
  const { saveClipboardImageAsTempFile, finish } = holdSave()
  let attached!: Promise<string | null>
  await act(async () => {
    attached = composer.result.current(image())
  })
  expect(saveClipboardImageAsTempFile.mock.calls[0]?.[0].png).toBeInstanceOf(Uint8Array)
  await act(async () => finish('/tmp/marked.png'))

  const id = await attached
  expect(id).not.toBeNull()
  expect(nativeChatImageOnlyPendingCountForTests()).toBe(0)
  expect(readNativeChatComposerDraft(scope).images.map((chip) => [chip.id, chip.path])).toEqual([
    [id, '/tmp/marked.png']
  ])
})

it('a marked image whose message box goes away while it saves is dropped, not kept without its notes', async () => {
  const scope = 'agent-session:notes-attach-gone'
  const composer = mountComposer(scope)
  const { finish } = holdSave()
  const notify = vi.spyOn(toast, 'error')
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let attached!: Promise<string | null>
  await act(async () => {
    attached = composer.result.current(image())
  })
  composer.unmount()
  await act(async () => finish('/tmp/marked.png'))

  expect(await attached).toBeNull()
  expect(readNativeChatComposerDraft(scope).images).toEqual([])
  expect(nativeChatImageOnlyPendingCountForTests()).toBe(0)
  expect(log.mock.calls).toEqual([
    ['[native-chat] saved image paste dropped', 'notes-image-destination-lost']
  ])
  // The notes viewer reports the failure; no paste notice names the wrong action.
  expect(notify).not.toHaveBeenCalled()
})

it('a chat that can’t take the marked image tells the viewer why, and posts nothing of its own', async () => {
  const scope = 'agent-session:notes-attach-refused'
  const setNotice = vi.fn()
  const composer = mountComposer(scope, { kind: 'not-ready' }, setNotice)
  const { saveClipboardImageAsTempFile } = holdSave()
  let error: unknown
  await act(async () => {
    error = await composer.result.current(image()).catch((reason: unknown) => reason)
  })
  expect(error).toBeInstanceOf(NativeChatGeneratedImageRefusedError)
  // Said once, in the viewer: Send gives the reason, Close's short line says it wasn't added.
  expect(nativeChatNotesHandOffErrorText(translate, error)).toBe(
    'Worktree not ready — try again in a moment.'
  )
  expect(nativeChatNotesCloseErrorText(translate, error)).toBe('Couldn’t add the marked image.')
  expect(setNotice).not.toHaveBeenCalled()
  expect(saveClipboardImageAsTempFile).not.toHaveBeenCalled()
  expect(readNativeChatComposerDraft(scope).images).toEqual([])
})

it('a marked image that fails to save leaves the message box quiet: the viewer reports it', async () => {
  const scope = 'agent-session:notes-attach-save-failed'
  const setNotice = vi.fn()
  const composer = mountComposer(scope, { kind: 'local' }, setNotice)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('api', {
    ui: {
      saveClipboardImageAsTempFile: vi.fn(async () => {
        throw new Error('disk full')
      })
    }
  })
  let attached: string | null | undefined
  await act(async () => {
    attached = await composer.result.current(image())
  })
  expect(attached).toBeNull()
  expect(readNativeChatComposerDraft(scope).images).toEqual([])
  expect(setNotice.mock.calls.filter(([notice]) => notice !== null)).toEqual([])
  expect(nativeChatImageOnlyPendingCountForTests()).toBe(0)
})

it('a chat that takes no images keeps no @path for a marked image, and the message is unchanged', async () => {
  const scope = 'agent-session:notes-attach-text-only'
  updateNativeChatComposerDraft(scope, { text: 'please check' }, 'immediate')
  const composer = mountComposer(scope, { kind: 'local' }, vi.fn(), { acceptsImages: false })
  const { finish } = holdSave()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  let attached!: Promise<string | null>
  await act(async () => {
    attached = composer.result.current(image())
  })
  await act(async () => finish('/tmp/marked.png'))

  expect(await attached).toBeNull()
  const draft = readNativeChatComposerDraft(scope)
  expect(draft.text).toBe('please check')
  expect(draft.images).toEqual([])
  expect(nativeChatImageOnlyPendingCountForTests()).toBe(0)
})

it('a marked image never takes the place of words selected in the message box', async () => {
  const scope = 'agent-session:notes-attach-selection'
  updateNativeChatComposerDraft(scope, { text: 'please check this' }, 'immediate')
  // An editor holding "check" selected, writing to the draft as the message box's does.
  const input = {
    value: 'please check this',
    selectionStart: 7,
    selectionEnd: 12,
    disabled: false,
    focus: noop,
    select: noop,
    setSelectionRange(from: number, to: number) {
      input.selectionStart = from
      input.selectionEnd = to
    },
    insertText(text: string) {
      input.value =
        input.value.slice(0, input.selectionStart) + text + input.value.slice(input.selectionEnd)
      updateNativeChatComposerDraft(scope, { text: input.value }, 'immediate')
    }
  }
  const composer = mountComposer(scope, { kind: 'local' }, vi.fn(), { input })
  const { finish } = holdSave()
  let attached!: Promise<string | null>
  await act(async () => {
    attached = composer.result.current(image())
  })
  await act(async () => finish('/tmp/marked.png'))

  const id = await attached
  const { text } = readNativeChatComposerDraft(scope)
  expect(text).toContain('please check')
  expect(text).toContain(`[Image](orca-image:${id})`)
  expect(text.indexOf('check')).toBeLessThan(text.indexOf('[Image]'))
})
