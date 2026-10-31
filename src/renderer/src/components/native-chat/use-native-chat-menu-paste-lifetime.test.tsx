// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import { nativeChatImageSendBlock } from './native-chat-image-reattach'
import {
  clearNativeChatComposerDraftsForTests,
  deleteNativeChatComposerDraftsOwnedBy,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  setNativeChatComposerDraftOwnerResolver,
  updateNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey as scope
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import {
  clearNativeChatPendingAttachmentsForTests,
  dropNativeChatPendingAttachmentsOwnedBy,
  nativeChatPendingAttachmentSnapshot
} from './native-chat-pending-attachment-cache'

let previousApi: typeof window.api
const draftOwner = { workspaceId: 'folder-1', executionHostId: 'local' as const }
beforeEach(async () => {
  previousApi = window.api
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
  setNativeChatComposerDraftOwnerResolver(() => draftOwner)
})
afterEach(async () => {
  vi.useRealTimers()
  cleanup()
  await nativeChatComposerDraftWritesSettled()
  clearNativeChatPendingAttachmentsForTests()
  clearNativeChatComposerDraftsForTests()
  window.api = previousApi
})

async function fixture(acceptsImages = true, source: 'menu' | 'event' = 'menu') {
  const save = Promise.withResolvers<string | null>()
  const thumbnail = Promise.withResolvers<{
    dataUrl: string
    width: number
    height: number
  } | null>()
  const owner: NativeChatAttachmentOwner = { kind: 'local' }
  const path = '/local/native-chat-pastes/orca-paste-1-image.png'
  const saveCall = vi.fn(() => save.promise)
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      ui: {
        readClipboardText: async () => '',
        readClipboardFilePaths: async () => [],
        clipboardHasImage: async () => true,
        readClipboardImageThumbnail: () => thumbnail.promise,
        saveClipboardImageAsTempFile: saveCall
      }
    }
  })
  const input = createRef<NativeChatComposerInput>()
  const view = renderHook(() => {
    const attachments = useNativeChatComposerAttachments({
      attachmentScopeKey: scope('menu'),
      allowWithoutTarget: true,
      acceptsImages,
      caret: 0,
      disabled: false,
      isComposing: () => false,
      resolveTarget: () => null,
      textareaRef: input,
      setCaret: () => {},
      setDraft: (update) =>
        updateNativeChatComposerDraft(
          scope('menu'),
          {
            text: update(readNativeChatComposerDraft(scope('menu')).text)
          },
          'immediate'
        ),
      setNotice: () => {}
    })
    const paste = useNativeChatComposerPaste({
      targetKey: 'menu',
      attachmentScopeKey: scope('menu'),
      agent: acceptsImages ? 'claude' : 'omp',
      disabled: false,
      caret: 0,
      resolveAttachmentOwner: () => owner,
      attachCopiedFiles: () => {},
      captureCopiedFiles: () => async () => {},
      ...attachments,
      insertTypedText: () => true,
      setCaret: () => {},
      setNotice: () => {}
    })
    return { paste, attachments }
  })
  await act(async () => {
    if (source === 'menu') {
      view.result.current.paste.pasteFromClipboard()
    } else {
      const data = new DataTransfer()
      data.items.add(new File(['png'], 'image.png', { type: 'image/png' }))
      view.result.current.paste.handlePaste(new ClipboardEvent('paste', { clipboardData: data }))
    }
  })
  await vi.waitFor(() =>
    expect(saveCall).toHaveBeenCalledExactlyOnceWith({ forNativeChatDraft: true })
  )
  return { view, save, thumbnail, path }
}

const referencePastes = [{ source: 'menu' }, { source: 'event' }] as const

it.each(
  referencePastes.flatMap((paste) =>
    [true, false].map((acceptsImages) => ({ ...paste, acceptsImages }))
  )
)(
  'can abandon stalled $source operations after reopen with acceptsImages=$acceptsImages',
  async ({ source, acceptsImages }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { view, save, thumbnail, path } = await fixture(acceptsImages, source)
    view.unmount()
    const reopened = renderHook(() =>
      useNativeChatComposerAttachments({
        attachmentScopeKey: scope('menu'),
        acceptsImages,
        allowWithoutTarget: true,
        caret: 0,
        disabled: false,
        isComposing: () => false,
        resolveTarget: () => null,
        textareaRef: createRef<NativeChatComposerInput>(),
        setCaret: () => {},
        setDraft: (update) =>
          updateNativeChatComposerDraft(
            scope('menu'),
            { text: update(readNativeChatComposerDraft(scope('menu')).text) },
            'immediate'
          ),
        setNotice: () => {}
      })
    )
    await act(async () => vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000))
    expect(reopened.result.current.imageAttachments).toHaveLength(1)
    expect(nativeChatImageSendBlock(reopened.result.current.imageAttachments).holdsSend).toBe(true)
    const id = reopened.result.current.imageAttachments[0].id
    await act(async () => reopened.result.current.removeImageAttachment(id))
    expect(nativeChatImageSendBlock(reopened.result.current.imageAttachments).holdsSend).toBe(false)
    await act(async () => save.resolve(path))
    await act(async () =>
      thumbnail.resolve({ dataUrl: 'data:image/png;base64,AA', width: 1, height: 1 })
    )
    expect(nativeChatPendingAttachmentSnapshot(scope('menu'))).toEqual([])
    expect(readNativeChatComposerDraft(scope('menu')).images).toEqual([])
    expect(readNativeChatComposerDraft(scope('menu')).text).toBe('')
  }
)
it.each(referencePastes)('keeps a $source paste as a reference after close', async ({ source }) => {
  const { view, save, thumbnail, path } = await fixture(false, source)
  await act(async () =>
    thumbnail.resolve({ dataUrl: 'data:image/png;base64,AA', width: 1, height: 1 })
  )
  expect(view.result.current.attachments.imageAttachments).toHaveLength(1)
  view.unmount()
  await act(async () => save.resolve(path))
  expect(nativeChatPendingAttachmentSnapshot(scope('menu'))).toEqual([])
  expect(readNativeChatComposerDraft(scope('menu')).text).toContain(path)
  expect(readNativeChatComposerDraft(scope('menu')).images).toEqual([])
})
it.each(referencePastes)(
  'keeps mounted $source paste references without image chips',
  async ({ source }) => {
    const { save, thumbnail, path } = await fixture(false, source)
    await act(async () => thumbnail.resolve(null))
    await act(async () => save.resolve(path))
    expect(readNativeChatComposerDraft(scope('menu')).text).toContain(path)
    expect(readNativeChatComposerDraft(scope('menu')).images).toEqual([])
  }
)

it('preserves menu uploads closed before a delayed or absent thumbnail', async () => {
  let completed = 0
  for (const preview of ['delayed', 'missing', 'present'] as const) {
    const { view, save, thumbnail, path } = await fixture()
    if (preview !== 'delayed') {
      await act(async () =>
        thumbnail.resolve(
          preview === 'present'
            ? { dataUrl: 'data:image/png;base64,AA', width: 1, height: 1 }
            : null
        )
      )
    }
    view.unmount()
    await act(async () => save.resolve(path))
    expect(nativeChatPendingAttachmentSnapshot(scope('menu'))).toEqual([])
    expect(readNativeChatComposerDraft(scope('menu')).images).toHaveLength(++completed)
    expect(readNativeChatComposerDraft(scope('menu')).images.at(-1)).toMatchObject({ path })
    if (preview === 'delayed') {
      await act(async () => thumbnail.resolve(null))
    }
  }
})

it('settles menu images without a thumbnail while mounted', async () => {
  const { save, thumbnail, path } = await fixture()
  await act(async () => thumbnail.resolve(null))
  await act(async () => save.resolve(path))
  expect(readNativeChatComposerDraft(scope('menu')).images[0]).toMatchObject({ path })
})

it.each([true, false])(
  'ends pending operations for acceptsImages=%s on removal, deletion or failure',
  async (acceptsImages) => {
    for (const end of ['remove', 'workspace', 'failure'] as const) {
      const { view, save, thumbnail, path } = await fixture(acceptsImages)
      if (end === 'remove') {
        const { attachments } = view.result.current
        await act(async () => attachments.removeImageAttachment(attachments.imageAttachments[0].id))
      } else if (end === 'workspace') {
        deleteNativeChatComposerDraftsOwnedBy(draftOwner)
        dropNativeChatPendingAttachmentsOwnedBy(draftOwner)
      }
      view.unmount()
      await act(async () => save.resolve(end === 'failure' ? null : path))
      await act(async () =>
        thumbnail.resolve({ dataUrl: 'data:image/png;base64,AA', width: 1, height: 1 })
      )
      expect(nativeChatPendingAttachmentSnapshot(scope('menu'))).toEqual([])
      expect(readNativeChatComposerDraft(scope('menu')).images).toEqual([])
      expect(readNativeChatComposerDraft(scope('menu')).text).toBe('')
    }
  }
)
