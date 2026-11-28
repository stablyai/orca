// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  readBrowserAttachmentFile,
  holdBrowserAttachmentFiles
} from '@/lib/files/drop/browser-attachment-files'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import type { NativeChatAttachmentOwner } from '../attachments/uploads/native-chat-attachment-owner'
import { useNativeChatComposerAttachments } from '../attachments/chips/use-native-chat-composer-attachments'
import { moveNativeChatComposerDraft } from '../drafts/native-chat-composer-draft-move'
import { deleteNativeChatComposerDraft } from '../drafts/native-chat-composer-draft-removal'
import { readNativeChatComposerDraft } from '../drafts/native-chat-composer-draft-store'
import {
  captureNativeChatStagedInput,
  releaseNativeChatStagedFiles
} from '../drafts/native-chat-draft-attachment-staging'
import { clearNativeChatComposerDraftsForTests } from '../drafts/native-chat-draft-reset'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create(() => ({})) }
})

afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  useAppStore.setState({ unifiedTabsByWorktree: {} })
  replaceRuntimeEnvironmentRevisions([])
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const noop = () => {}

function mountComposer(scope: string, owner: NativeChatAttachmentOwner, acceptsImages = true) {
  const setNotice = vi.fn()
  const textareaRef = { current: null }
  const hook = renderHook(
    ({ targetKey, disabled, attachmentOwner }) => {
      const attachments = useNativeChatComposerAttachments({
        attachmentScopeKey: scope,
        allowWithoutTarget: true,
        acceptsImages,
        imageReferences: true,
        caret: 0,
        disabled,
        isComposing: () => false,
        resolveTarget: () => null,
        textareaRef,
        setCaret: noop,
        setDraft: noop,
        setNotice
      })
      const paste = useNativeChatComposerPaste({
        ...attachments,
        attachmentScopeKey: scope,
        targetKey,
        disabled,
        caret: 0,
        resolveAttachmentOwner: () => attachmentOwner,
        attachCopiedFiles: noop,
        captureCopiedFiles: () => async () => {},
        insertTypedText: () => false,
        setCaret: noop,
        setNotice
      })
      return { ...attachments, ...paste }
    },
    { initialProps: { targetKey: 'pending', disabled: false, attachmentOwner: owner } }
  )
  return { ...hook, setNotice }
}

async function pasteImage(composer: ReturnType<typeof mountComposer>) {
  const save = Promise.withResolvers<string>()
  const saveClipboardImageAsTempFile = vi.fn(() => save.promise)
  vi.stubGlobal('api', {
    ui: { saveClipboardImageAsTempFile },
    runtimeEnvironments: {
      call: async () => ({
        ok: true,
        result: { capabilities: ['agent-session.attachments.v1'], runtimeId: 'paired-runtime' }
      })
    },
    fs: {
      uploadPathsToAgentSessionAttachments: async ({ paths }: { paths: string[] }) => ({
        uploaded: paths.map((sourcePath) => ({
          sourcePath,
          path: '/paired/attachments/paste.png'
        })),
        skipped: [],
        failed: []
      })
    }
  })
  const clipboardData = new DataTransfer()
  clipboardData.items.add(new File(['image'], 'paste.png', { type: 'image/png' }))
  await act(async () => {
    composer.result.current.handlePaste(
      new ClipboardEvent('paste', { clipboardData, cancelable: true })
    )
  })
  expect(saveClipboardImageAsTempFile).toHaveBeenCalledTimes(1)
  return (path: string) => act(async () => save.resolve(path))
}

function publishPairedChat(sessionId: string) {
  replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 1 }])
  useAppStore.setState({
    unifiedTabsByWorktree: {
      'paste-workspace': [
        {
          id: 'paste-tab',
          entityId: sessionId,
          groupId: 'paste-group',
          worktreeId: 'paste-workspace',
          executionHostId: 'runtime:paired',
          contentType: 'agent-session',
          label: 'Test chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  })
}

function holdTestImage() {
  return holdBrowserAttachmentFiles([new File(['image'], 'paste.png', { type: 'image/png' })])[0]
}

it('keeps a saved paste through a disabled composer and its first session handoff', async () => {
  const source = 'pending-worktree-creation:paste-test'
  const destination = 'agent-session:paste-test'
  const path = '/tmp/saved-paste.png'
  const owner = { kind: 'local' as const, stagingScope: source }
  const composer = mountComposer(source, owner)
  const finish = await pasteImage(composer)
  composer.rerender({ targetKey: 'opening-session', disabled: true, attachmentOwner: owner })
  publishPairedChat('paste-test')
  act(() => moveNativeChatComposerDraft(source, destination))
  composer.unmount()
  await finish(path)

  expect(composer.setNotice.mock.lastCall).toEqual([null])
  expect(readNativeChatComposerDraft(source).images).toEqual([])
  const draft = readNativeChatComposerDraft(destination)
  expect(draft.images.map((image) => image.path)).toEqual(['/tmp/saved-paste.png'])
  const staged = captureNativeChatStagedInput(destination, {
    text: draft.text,
    attachments: draft.images
  })
  try {
    const input = await staged.prepare(
      { text: draft.text, attachments: draft.images },
      {
        sessionId: 'paste-test',
        runtimeEnvironmentId: 'paired'
      }
    )
    expect(input.attachments.map(({ path: attachment }) => attachment)).toEqual([
      '/paired/attachments/paste.png'
    ])
  } finally {
    staged.release()
    releaseNativeChatStagedFiles(destination)
  }
})

it('keeps a file reference in the same draft after its target changes', async () => {
  const scope = 'agent-session:file-reference'
  const owner = { kind: 'local' as const, structuredSessionId: 'initial' }
  const composer = mountComposer(scope, owner, false)
  const finish = await pasteImage(composer)
  composer.rerender({
    targetKey: 'replacement',
    disabled: true,
    attachmentOwner: { ...owner, structuredSessionId: 'replacement' }
  })
  await finish('/tmp/paste.png')

  const draft = readNativeChatComposerDraft(scope)
  expect(draft.text.trim()).toBe('@/tmp/paste.png')
  expect(draft.images).toEqual([])
})

it.each([false, true])(
  'refuses a saved path owned by a different paired session (disabled: %s)',
  async (disabled) => {
    const scope = 'agent-session:initial'
    const owner = {
      kind: 'runtime-session' as const,
      environmentId: 'paired',
      pairingRevision: 1,
      sessionId: 'initial'
    }
    publishPairedChat('initial')
    const composer = mountComposer(scope, owner)
    const notify = vi.spyOn(toast, 'error')
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const finish = await pasteImage(composer)
    composer.rerender({
      targetKey: 'replacement',
      disabled,
      attachmentOwner: { ...owner, sessionId: 'replacement' }
    })
    await finish('/paired/attachments/initial.png')

    expect(readNativeChatComposerDraft(scope)).toMatchObject({ text: '', images: [] })
    expect(composer.result.current.imageAttachments).toEqual([])
    expect(log.mock.calls).toEqual([['[native-chat] saved image paste dropped', 'owner-changed']])
    expect(notify.mock.calls).toEqual(disabled ? [['Image paste failed.']] : [])
    expect(composer.setNotice.mock.calls).toEqual(
      disabled ? [[null]] : [[null], ['Image paste failed.']]
    )
  }
)

it('refuses a saved path on a different host after a move and unmount', async () => {
  const source = 'agent-session:move-source'
  const destination = 'agent-session:move-destination'
  const composer = mountComposer(source, { kind: 'local' })
  const notify = vi.spyOn(toast, 'error')
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const finish = await pasteImage(composer)
  const path = holdTestImage()
  publishPairedChat('move-destination')
  act(() => moveNativeChatComposerDraft(source, destination))
  expect(readNativeChatComposerDraft(destination).text).not.toBe('')
  composer.unmount()
  await finish(path)

  expect(readNativeChatComposerDraft(destination)).toMatchObject({ text: '', images: [] })
  const remounted = mountComposer(destination, { kind: 'local' })
  expect(remounted.result.current.imageAttachments).toEqual([])
  expect(readBrowserAttachmentFile(path)).toBeNull()
  expect(log.mock.calls).toEqual([['[native-chat] saved image paste dropped', 'owner-changed']])
  expect(notify.mock.calls).toEqual([['Image paste failed.']])
  expect(composer.setNotice.mock.calls).toEqual([[null]])
})

it('recognizes deliberate removal by a remounted composer and quietly releases the saved file', async () => {
  const scope = 'pending-worktree-creation:remove-paste'
  const owner = { kind: 'local' as const, stagingScope: scope }
  const composer = mountComposer(scope, owner)
  const notify = vi.spyOn(toast, 'error')
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const finish = await pasteImage(composer)
  const path = holdTestImage()
  composer.unmount()
  const replacement = mountComposer(scope, owner)
  const [chip] = replacement.result.current.imageAttachments
  act(() => replacement.result.current.removeImageAttachment(chip.id))
  await finish(path)

  expect(readNativeChatComposerDraft(scope)).toMatchObject({ text: '', images: [] })
  expect(replacement.result.current.imageAttachments).toEqual([])
  expect(readBrowserAttachmentFile(path)).toBeNull()
  expect(log.mock.calls).toEqual([['[native-chat] saved image paste dropped', 'removed']])
  expect(notify).not.toHaveBeenCalled()
  expect(replacement.setNotice).not.toHaveBeenCalled()
  expect(composer.setNotice.mock.calls).toEqual([[null]])
})

it('reports a cleared draft once through the mounted composer and releases the saved file', async () => {
  const scope = 'pending-worktree-creation:clear-paste'
  const composer = mountComposer(scope, { kind: 'local', stagingScope: scope })
  const notify = vi.spyOn(toast, 'error')
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const finish = await pasteImage(composer)
  const path = holdTestImage()
  act(() => {
    composer.result.current.clearImageAttachments()
    deleteNativeChatComposerDraft(scope)
  })
  await finish(path)

  expect(readNativeChatComposerDraft(scope)).toMatchObject({ text: '', images: [] })
  expect(composer.result.current.imageAttachments).toEqual([])
  expect(readBrowserAttachmentFile(path)).toBeNull()
  expect(log.mock.calls).toEqual([['[native-chat] saved image paste dropped', 'destination-lost']])
  expect(notify).not.toHaveBeenCalled()
  expect(composer.setNotice.mock.calls).toEqual([[null], ['Image paste failed.']])
})
