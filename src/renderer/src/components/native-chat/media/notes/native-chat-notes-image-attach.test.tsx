// @vitest-environment happy-dom
// A marked notes image is attached only to the message box that asked for it.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useNativeChatComposerAttachments } from '../../attachments/chips/use-native-chat-composer-attachments'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { useNativeChatComposerPaste } from '../../paste/use-native-chat-composer-paste'
import { useNativeChatGeneratedImageAttach } from '../../paste/use-native-chat-generated-image-attach'

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

function mountComposer(scope: string) {
  const setNotice = vi.fn()
  const textareaRef = { current: null }
  return renderHook(() => {
    const attachments = useNativeChatComposerAttachments({
      attachmentScopeKey: scope,
      allowWithoutTarget: true,
      acceptsImages: true,
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
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      attachCopiedFiles: noop,
      captureCopiedFiles: () => async () => {},
      insertTypedText: () => false,
      setCaret: noop,
      setNotice
    })
    return useNativeChatGeneratedImageAttach(paste, () => ({ kind: 'local' }), setNotice)
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
  expect(log.mock.calls).toEqual([
    ['[native-chat] saved image paste dropped', 'notes-image-destination-lost']
  ])
  // The notes viewer reports the failure; no paste notice names the wrong action.
  expect(notify).not.toHaveBeenCalled()
})
