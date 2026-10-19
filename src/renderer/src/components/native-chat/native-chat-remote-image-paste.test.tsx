// @vitest-environment happy-dom
// #27997: a clipboard image pasted into a terminal-backed chat on a managed SSH host or paired
// server, through the real composer attachment guards rather than a fake chip store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import type * as RemoteRuntimePtyIdModule from '../../../../shared/remote-runtime-pty-id'

const mocks = vi.hoisted(() => ({
  saveClipboardImageAsTempFile: vi.fn(),
  readClipboardText: vi.fn(),
  readClipboardImageThumbnail: vi.fn(),
  clipboardHasImage: vi.fn(),
  readClipboardFilePaths: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('../../../../shared/remote-runtime-pty-id', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
  isRemoteRuntimePtyId: () => true
}))

vi.stubGlobal('window', {
  ...window,
  api: {
    ui: {
      saveClipboardImageAsTempFile: mocks.saveClipboardImageAsTempFile,
      readClipboardText: mocks.readClipboardText,
      readClipboardImageThumbnail: mocks.readClipboardImageThumbnail,
      clipboardHasImage: mocks.clipboardHasImage,
      readClipboardFilePaths: mocks.readClipboardFilePaths
    }
  }
})
vi.stubGlobal('URL', {
  ...URL,
  createObjectURL: () => 'blob:clipboard-image',
  revokeObjectURL: () => {}
})

import {
  clearNativeChatAttachmentCacheForTests,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import { hydrateNativeChatComposerDrafts } from './native-chat-composer-draft-store'

type Api = {
  attachments: ReturnType<typeof useNativeChatComposerAttachments>
  paste: ReturnType<typeof useNativeChatComposerPaste>
  draft: string
  notice: string | null
}

function Probe({
  acceptsImages,
  owner,
  onReady
}: {
  acceptsImages: boolean
  owner: () => NativeChatAttachmentOwner
  onReady: (api: Api) => void
}): React.JSX.Element {
  const [caret, setCaret] = useState(0)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachments = useNativeChatComposerAttachments({
    attachmentScopeKey: 'remote-scope',
    acceptsImages,
    caret,
    disabled: false,
    isComposing: () => false,
    resolveTarget: () => ({ ptyId: 'remote:env-1@@pty-1' }),
    textareaRef,
    setCaret,
    setDraft: (updater) => setDraft((previous) => updater(previous)),
    setNotice
  })
  const paste = useNativeChatComposerPaste({
    targetKey: 'remote-scope',
    attachmentScopeKey: 'remote-scope',
    agent: 'claude',
    disabled: false,
    caret,
    resolveAttachmentOwner: owner,
    attachResolvedPaths: attachments.attachResolvedPaths,
    attachCopiedFiles: () => {},
    captureCopiedFiles: () => async () => {},
    beginPendingImageAttachment: attachments.beginPendingImageAttachment,
    resolvePendingImageAttachment: attachments.resolvePendingImageAttachment,
    revealPendingImageAttachment: attachments.revealPendingImageAttachment,
    dropPendingImageAttachment: attachments.dropPendingImageAttachment,
    insertTypedText: () => true,
    setCaret,
    setNotice
  })
  useEffect(() => {
    onReady({ attachments, paste, draft, notice })
  })
  return createElement('textarea', { ref: textareaRef })
}

let root: Root | null = null

async function render(
  owner: () => NativeChatAttachmentOwner,
  acceptsImages = true
): Promise<() => Api> {
  const container = document.createElement('div')
  document.body.append(container)
  let api: Api | null = null
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(Probe, { acceptsImages, owner, onReady: (next) => (api = next) }))
  })
  return () => {
    if (!api) {
      throw new Error('Probe did not render')
    }
    return api
  }
}

function imagePasteEvent(): ClipboardEvent {
  const data = new DataTransfer()
  data.items.add(new File(['image'], 'image.png', { type: 'image/png' }))
  return new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
}

const SERVER_OWNER: NativeChatAttachmentOwner = {
  kind: 'remote',
  clipboardImageEnvironmentId: 'env-1'
}

beforeEach(async () => {
  // Why: a draft first written before the load lands is rebuilt from storage, which keeps a
  // remote paste by name only; a running app has loaded long before any paste.
  await hydrateNativeChatComposerDrafts()
  vi.resetAllMocks()
  mocks.readClipboardText.mockResolvedValue('')
  mocks.readClipboardImageThumbnail.mockResolvedValue(null)
  mocks.clipboardHasImage.mockResolvedValue(true)
  mocks.readClipboardFilePaths.mockResolvedValue([])
  mocks.saveClipboardImageAsTempFile.mockResolvedValue('/tmp/orca-paste-remote.png')
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  clearNativeChatAttachmentCacheForTests()
})

describe('clipboard image paste into a remote terminal-backed chat', () => {
  it.each(['event', 'menu'] as const)(
    'attaches the image saved on the server via %s paste',
    async (source) => {
      const latest = await render(() => SERVER_OWNER)
      await act(async () =>
        source === 'event'
          ? latest().paste.handlePaste(imagePasteEvent())
          : latest().paste.pasteFromClipboard()
      )
      expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledWith({
        runtimeEnvironmentId: 'env-1'
      })
      expect(latest().attachments.imageAttachments).toMatchObject([
        { path: '/tmp/orca-paste-remote.png' }
      ])
      expect(latest().attachments.imageAttachments[0]?.pending).toBeUndefined()
      expect(latest().notice).toBeNull()
    }
  )

  it('inserts the server path as a reference for an agent that takes no images', async () => {
    const latest = await render(() => SERVER_OWNER, false)
    await act(async () => latest().paste.handlePaste(imagePasteEvent()))
    expect(latest().draft).toContain('/tmp/orca-paste-remote.png')
    expect(latest().notice).toBeNull()
  })

  it('still refuses a nested SSH host the server does not serve', async () => {
    const latest = await render(() => ({ kind: 'remote' }))
    await act(async () => latest().paste.pasteFromClipboard())
    expect(mocks.saveClipboardImageAsTempFile).not.toHaveBeenCalled()
    expect(latest().attachments.imageAttachments).toHaveLength(0)
    expect(latest().notice).toBe('Local attachments are not available for remote sessions.')
  })

  it('still refuses client files dropped onto the remote target', async () => {
    const latest = await render(() => SERVER_OWNER)
    act(() => latest().attachments.attachResolvedPaths(['/Users/me/local.png'], null))
    expect(latest().attachments.imageAttachments).toHaveLength(0)
    expect(latest().notice).toBe('Local attachments are not available for remote sessions.')
  })
})
