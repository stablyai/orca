// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AttachmentUploadModule from './native-chat-attachment-upload'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import {
  createNativeChatQueuedEditDraft,
  handBackNativeChatQueuedEdit,
  discardNativeChatQueuedEdit
} from './native-chat-queued-edit-draft'
import {
  readNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests
} from './native-chat-composer-draft-store'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'
import { nativeChatPendingAttachmentSnapshot } from './native-chat-pending-attachment-cache'
import { nativeChatImagesHoldSend } from './native-chat-image-reattach'
import { readNativeChatDraftCache } from './native-chat-draft-cache'
import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import {
  clearNativeChatAttachmentCacheForTests,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'
import type * as RemoteRuntimePtyIdModule from '../../../../shared/remote-runtime/remote-runtime-pty-id'

const mocks = vi.hoisted(() => {
  const state: {
    owner: NativeChatAttachmentOwner
    remoteTarget: boolean
    stat: ReturnType<typeof vi.fn>
    readText: ReturnType<typeof vi.fn>
    upload: ReturnType<typeof vi.fn>
    tabsByWorktree: Record<string, { id: string }[]>
  } = {
    owner: { kind: 'local' },
    remoteTarget: false,
    stat: vi.fn(),
    readText: vi.fn(),
    upload: vi.fn(),
    tabsByWorktree: { 'workspace-1': [{ id: 'tab-1' }] }
  }
  return state
})
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: () => unknown) => select(), {
    getState: () => ({ tabsByWorktree: mocks.tabsByWorktree })
  })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../../../../shared/remote-runtime/remote-runtime-pty-id', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
  isRemoteRuntimePtyId: () => mocks.remoteTarget
}))
vi.mock('./native-chat-attachment-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentUploadModule>()),
  resolveNativeChatAttachmentOwner: () => mocks.owner,
  resolveNativeChatAttachmentOwnerForWorktree: () => mocks.owner,
  prepareNativeChatSessionAttachmentUpload: async () => ({ ok: true, target: {} })
}))

type Api = ReturnType<typeof useNativeChatExternalAttachments> &
  ReturnType<typeof useNativeChatComposerAttachments> &
  ReturnType<typeof useNativeChatComposerPaste> &
  ReturnType<typeof useNativeChatFileAttachmentActions>
let api: Api | undefined
let root: Root
let container: HTMLDivElement
let composing = true

function Probe({
  worktreeId,
  acceptsImages = true,
  disabled = false,
  scope = 'drop-test'
}: {
  worktreeId?: string
  acceptsImages?: boolean
  disabled?: boolean
  scope?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachments = useNativeChatComposerAttachments({
    attachmentScopeKey: scope,
    acceptsImages,
    caret,
    disabled,
    isComposing: () => composing,
    resolveTarget: () => ({ ptyId: 'pty-1', settings: { activeRuntimeEnvironmentId: null } }),
    textareaRef,
    setCaret,
    setDraft,
    setNotice
  })
  const external = useNativeChatExternalAttachments({
    terminalTabId: 'tab-1',
    draftScopeKey: scope,
    structuredWorktreeId: worktreeId,
    disabled,
    attachResolvedPaths: attachments.attachResolvedPaths,
    pendingChips: attachments.pendingChips,
    setNotice
  })
  const paste = useNativeChatComposerPaste({
    attachmentScopeKey: scope,
    agent: 'claude',
    disabled,
    caret,
    setCaret,
    resolveAttachmentOwner: external.resolveAttachmentOwner,
    attachResolvedPaths: attachments.attachResolvedPaths,
    attachCopiedFiles: external.attachExternalPaths,
    captureExternalPaths: () => external.captureExternalDrop(undefined, { focus: false }),
    captureCopiedFiles: (options) => external.captureReservedAttachments(undefined, options),
    beginPendingImageAttachment: attachments.beginPendingImageAttachment,
    resolvePendingImageAttachment: attachments.pendingChips.resolve,
    revealPendingImageAttachment: attachments.revealPendingImageAttachment,
    dropPendingImageAttachment: attachments.dropPendingImageAttachment,
    insertTypedText: () => true,
    setNotice
  })
  const picker = useNativeChatFileAttachmentActions(() => external.captureExternalDrop())
  api = { ...attachments, ...external, ...paste, ...picker }
  return (
    <>
      <textarea ref={textareaRef} />
      <output data-draft>{draft}</output>
      <output data-notice>{notice}</output>
    </>
  )
}

function latest(): Api {
  if (!api) {
    throw new Error('Attachment probe did not render')
  }
  return api
}

async function render(worktreeId?: string, acceptsImages = true, disabled = false): Promise<void> {
  await act(async () =>
    root.render(<Probe worktreeId={worktreeId} acceptsImages={acceptsImages} disabled={disabled} />)
  )
}

beforeEach(() => {
  api = undefined
  composing = true
  mocks.owner = { kind: 'local' }
  mocks.remoteTarget = false
  mocks.stat.mockReset().mockResolvedValue(undefined)
  mocks.tabsByWorktree = { 'workspace-1': [{ id: 'tab-1' }] }
  vi.stubGlobal('api', {
    fs: {
      stat: mocks.stat,
      getPathForFile: (file: File) => `/Users/me/${file.name}`,
      uploadPathsToAgentSessionAttachments: mocks.upload
    },
    ui: { readClipboardText: mocks.readText, readClipboardImageThumbnail: async () => null }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  clearNativeChatAttachmentCacheForTests()
  clearNativeChatComposerDraftsForTests()
  vi.unstubAllGlobals()
})

describe('OS attachment destination through input-method composition', () => {
  it.each(['workspace', 'host', 'terminal-workspace'])(
    'refuses queued files after the %s changes',
    async (change) => {
      await render(change === 'terminal-workspace' ? undefined : 'workspace-1')
      await act(async () => latest().attachExternalPaths(['/local/file.txt', '/local/image.png']))
      expect(nativeChatPendingAttachmentSnapshot('drop-test')).toHaveLength(2)
      expect(container.querySelector('[data-draft]')?.textContent).toBe('')
      if (change === 'workspace') {
        await render('workspace-2')
      }
      if (change === 'host') {
        mocks.owner = { kind: 'remote' }
      }
      if (change === 'terminal-workspace') {
        mocks.tabsByWorktree = { 'workspace-1': [] }
      }
      composing = false
      act(() => latest().flushPendingAttachments())
      expect(container.querySelector('[data-draft]')?.textContent).toBe('')
      expect(latest().imageAttachments).toEqual([])
      expect(nativeChatPendingAttachmentSnapshot('drop-test')).toEqual([])
      expect(container.querySelector('[data-notice]')?.textContent).toBe(
        'This workspace changed hosts while attaching — drop the files again.'
      )
    }
  )

  it('attaches an unchanged queued OS destination normally', async () => {
    await render('workspace-1')
    await act(async () => latest().attachExternalPaths(['/local/file.txt']))
    expect(readNativeChatDraftCache('drop-test')).toBe('')
    expect(nativeChatPendingAttachmentSnapshot('drop-test')).toHaveLength(1)
    composing = false
    act(() => latest().flushPendingAttachments())
    expect(container.querySelector('[data-draft]')?.textContent).toBe('@/local/file.txt ')
    expect(nativeChatPendingAttachmentSnapshot('drop-test')).toEqual([])
  })

  it.each([true, false])(
    'uses current image support when queued with acceptsImages=%s',
    async (acceptsImages) => {
      const path = '/local/image.png'
      await render('workspace-1', acceptsImages)
      await act(async () => latest().attachExternalPaths([path]))
      expect(mocks.stat).toHaveBeenCalledOnce()
      expect(nativeChatPendingAttachmentSnapshot('drop-test')).toHaveLength(1)
      expect(latest().imageAttachments.every(({ pending }) => pending)).toBe(true)
      expect(container.querySelector('[data-draft]')?.textContent).toBe('')

      const currentAcceptsImages = !acceptsImages
      await render('workspace-1', currentAcceptsImages)
      composing = false
      act(() => latest().flushPendingAttachments())
      act(() => latest().flushPendingAttachments())

      expect(nativeChatPendingAttachmentSnapshot('drop-test')).toEqual([])
      expect(latest().imageAttachments.map(({ path }) => path)).toEqual(
        currentAcceptsImages ? [path] : []
      )
      expect(nativeChatImagesHoldSend(latest().imageAttachments)).toBe(false)
      expect(container.querySelector('[data-draft]')?.textContent).toBe(
        currentAcceptsImages ? '' : `@${path} `
      )
    }
  )

  it.each([true, false])(
    'keeps the workspace-file exemption off OS drops (queued=$queued)',
    async (queued) => {
      composing = queued
      await render('workspace-1')
      if (!queued) {
        mocks.remoteTarget = true
      }
      await act(async () => latest().attachExternalPaths(['/local/file.txt', '/local/image.png']))
      if (queued) {
        mocks.remoteTarget = true
        composing = false
        act(() => latest().flushPendingAttachments())
      }
      expect(container.querySelector('[data-draft]')?.textContent).toBe('')
      expect(latest().imageAttachments).toEqual([])
      expect(container.querySelector('[data-notice]')?.textContent).toBe(
        'Local attachments are not available for remote sessions.'
      )
    }
  )

  it('reserves before stat and settles the captured scope across removal, failure and remount', async () => {
    let finish = (): void => {}
    mocks.stat
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finish = resolve
        })
      )
      .mockRejectedValueOnce(new Error('unreadable'))
    await render('workspace-1')
    act(() => latest().attachExternalPaths(['/a.png', '/bad.png', '/removed.png', '/notes.txt']))
    expect(nativeChatImagesHoldSend(latest().imageAttachments)).toBe(true)
    expect(nativeChatPendingAttachmentSnapshot('drop-test')).toHaveLength(4)
    const removed = latest().imageAttachments.find(
      ({ pendingName }) => pendingName === 'removed.png'
    )
    if (!removed) {
      throw new Error('Missing reserved chip')
    }
    act(() => latest().removeImageAttachment(removed.id))
    act(() => root.unmount())
    await act(async () => finish())
    expect(nativeChatPendingAttachmentSnapshot('drop-test')).toEqual([])
    root = createRoot(container)
    await render('workspace-1')
    expect(latest().imageAttachments).toMatchObject([{ path: '/a.png' }])
    expect(latest().imageAttachments).toHaveLength(1)
    expect(nativeChatImagesHoldSend(latest().imageAttachments)).toBe(false)
    expect(readNativeChatDraftCache('drop-test')).toBe('@/notes.txt')
  })

  it('preserves paste focus for references and image conversion, with drop focus as the default', async () => {
    composing = false
    await render('workspace-1', false)
    const other = document.createElement('input')
    container.append(other)
    other.focus()
    await act(async () => latest().attachExternalPaths(['/a.png', '/notes.txt'], { focus: false }))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(document.activeElement).toBe(other)
    expect(container.querySelector('[data-draft]')?.textContent).toContain('@/a.png')
    expect(container.querySelector('[data-draft]')?.textContent).toContain('@/notes.txt')
    await act(async () => latest().attachExternalPaths(['/drop.txt']))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(document.activeElement).toBe(container.querySelector('textarea'))
  })

  it('settles prepared pending work quietly when composition loses its composer', async () => {
    await render('workspace-1')
    await act(async () => latest().attachExternalPaths(['/a.png', '/notes.txt', '/removed.png']))
    const removed = latest().imageAttachments.find(
      ({ pendingName }) => pendingName === 'removed.png'
    )
    if (!removed) {
      throw new Error('Missing reserved chip')
    }
    act(() => latest().removeImageAttachment(removed.id))
    const other = document.createElement('input')
    document.body.append(other)
    other.focus()
    act(() => root.unmount())
    expect(nativeChatPendingAttachmentSnapshot('drop-test')).toEqual([])
    expect(readNativeChatDraftCache('drop-test')).toBe('@/notes.txt')
    root = createRoot(container)
    await render('workspace-1')
    expect(latest().imageAttachments).toMatchObject([{ path: '/a.png' }])
    expect(latest().imageAttachments).toHaveLength(1)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('releases refused and disabled work, including stat spanning disable and re-enable', async () => {
    await render('workspace-1')
    act(() =>
      latest().attachResolvedPaths(Array.from({ length: 256 }, (_, i) => `/queued/${i}.txt`))
    )
    await act(async () => latest().attachExternalPaths(['/refused.png']))
    expect(nativeChatPendingAttachmentSnapshot('drop-test')).toEqual([])
    let finish = (): void => {}
    mocks.stat.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    act(() => latest().attachExternalPaths(['/late.png']))
    await render('workspace-1', true, true)
    await render('workspace-1')
    await act(async () => finish())
    act(() => latest().flushPendingAttachments())
    expect(nativeChatPendingAttachmentSnapshot('drop-test')).toEqual([])
    expect(latest().imageAttachments).toEqual([])
    expect(container.querySelector('[data-draft]')?.textContent).toBe('')
  })
})

describe('a macOS paste the clipboard shows is Finder files', () => {
  let answer: (text: string) => void = () => {}
  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)')
    mocks.readText.mockReset().mockReturnValue(
      new Promise<string>((resolve) => {
        answer = resolve
      })
    )
  })
  afterEach(() => vi.restoreAllMocks())

  function pasteFinderCopy(names: string[]): void {
    const data = new DataTransfer()
    for (const name of names) {
      data.items.add(new File(['x'], name, { type: name.endsWith('.png') ? 'image/png' : '' }))
    }
    act(() =>
      latest().handlePaste(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }))
    )
  }
  async function answerClipboard(text: string): Promise<void> {
    await act(async () => {
      answer(text)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  function chipNamed(name: string): string {
    const chip = latest().imageAttachments.find(({ pendingName }) => pendingName === name)
    if (!chip) {
      throw new Error(`Missing reserved chip ${name}`)
    }
    return chip.id
  }

  it('attaches nothing the user removed, before or after the clipboard answered', async () => {
    await render('workspace-1')
    pasteFinderCopy(['a.png', 'notes.txt', 'late.txt'])
    expect(nativeChatImagesHoldSend(latest().imageAttachments)).toBe(true)
    act(() => latest().removeImageAttachment(chipNamed('a.png')))
    await answerClipboard('a.png\nnotes.txt\nlate.txt')
    // References wait for the input-method composition, and Send waits with them.
    expect(container.querySelector('[data-draft]')?.textContent).toBe('')
    expect(nativeChatImagesHoldSend(latest().imageAttachments)).toBe(true)
    act(() => latest().removeImageAttachment(chipNamed('late.txt')))
    composing = false
    act(() => latest().flushPendingAttachments())
    expect(container.querySelector('[data-draft]')?.textContent).toBe('@/Users/me/notes.txt ')
    expect(latest().imageAttachments).toEqual([])
    expect(mocks.stat).toHaveBeenCalledTimes(2)
  })

  it.each(['local', 'runtime-session'])(
    'finishes a %s paste into its draft when the composer unmounts before the clipboard answers',
    async (route) => {
      const stored = route === 'local' ? '/Users/me' : '/srv/store'
      if (route === 'runtime-session') {
        mocks.owner = {
          kind: 'runtime-session',
          environmentId: 'env-1',
          pairingRevision: 1,
          sessionId: 's'
        }
        mocks.upload.mockResolvedValue({
          uploaded: ['a.png', 'notes.txt'].map((name) => ({
            sourcePath: `/Users/me/${name}`,
            path: `${stored}/${name}`
          })),
          skipped: [],
          failed: []
        })
      }
      await render('workspace-1')
      pasteFinderCopy(['a.png', 'notes.txt'])
      const ids = nativeChatPendingAttachmentSnapshot('drop-test').map(({ id }) => id)
      expect(new Set(ids).size).toBe(2)
      act(() => root.unmount())
      await answerClipboard('a.png\nnotes.txt')
      expect(nativeChatPendingAttachmentSnapshot('drop-test')).toEqual([])
      root = createRoot(container)
      await render('workspace-1')
      expect(latest().imageAttachments).toEqual([
        expect.objectContaining({ id: ids[0], path: `${stored}/a.png` })
      ])
      expect(readNativeChatDraftCache('drop-test')).toBe(`@${stored}/notes.txt`)
    }
  )

  it('does not bring back a paste that disabling the composer cleared', async () => {
    composing = false
    await render('workspace-1')
    pasteFinderCopy(['a.png', 'notes.txt'])
    await render('workspace-1', true, true)
    await render('workspace-1')
    await answerClipboard('a.png\nnotes.txt')
    expect(nativeChatPendingAttachmentSnapshot('drop-test')).toEqual([])
    expect(latest().imageAttachments).toEqual([])
    expect(container.querySelector('[data-draft]')?.textContent).toBe('')
    expect(mocks.stat).not.toHaveBeenCalled()
  })
})

describe('captured edit picker and menu destination', () => {
  it.each(['picker', 'menu'] as const)(
    'keeps a deferred %s result with the original bottom after hand-back, and retires it on Cancel',
    async (route) => {
      for (const cancel of [false, true]) {
        const edit = createNativeChatQueuedEditDraft(
          { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'original' }] },
          'original-bottom'
        )
        let pickerAnswer = (_paths: string[]) => {}
        let clipboardAnswer = (_read: string) => {}
        window.api.shell = {
          ...window.api.shell,
          pickAttachments: () =>
            new Promise<string[]>((resolve) => {
              pickerAnswer = resolve
            })
        }
        window.api.ui.readClipboardFilePaths = async () => ['/late.txt', '/late.png']
        window.api.ui.clipboardHasImage = async () => false
        window.api.ui.readClipboardText = () =>
          new Promise((resolve) => {
            clipboardAnswer = resolve
          })
        composing = false
        await act(async () => root.render(<Probe worktreeId="workspace-1" scope={edit.scopeKey} />))
        act(() => (route === 'picker' ? latest().pickAttachments() : latest().pasteFromClipboard()))
        if (cancel) {
          discardNativeChatQueuedEdit(edit)
        } else {
          handBackNativeChatQueuedEdit(edit)
        }
        act(() => root.unmount())
        await act(async () => {
          pickerAnswer(['/late.txt', '/late.png'])
          clipboardAnswer('/late.txt\n/late.png')
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        const bottom = readNativeChatComposerDraft('original-bottom')
        expect(bottom.text).toBe(cancel ? '' : '@/late.txt')
        expect(bottom.images.map(({ path }) => path)).toEqual(cancel ? [] : ['/late.png'])
        expect(nativeChatPendingAttachmentSnapshot('original-bottom')).toEqual([])
        root = createRoot(container)
        clearNativeChatComposerDraftsForTests()
      }
    }
  )
})

it.each(['ordinary', 'edit'] as const)(
  'keeps unreadable-picker failure outcome on the moved %s entry point',
  async (kind) => {
    const edit =
      kind === 'edit'
        ? createNativeChatQueuedEditDraft(
            { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'original' }] },
            'bottom'
          )
        : undefined
    const scope = edit?.scopeKey ?? 'drop-test'
    composing = false
    mocks.stat.mockRejectedValue(new Error('unreadable'))
    window.api.shell = { ...window.api.shell, pickAttachments: async () => ['/unreadable.png'] }
    await act(async () => root.render(<Probe worktreeId="workspace-1" scope={scope} />))
    await act(async () => {
      latest().pickAttachments()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(nativeChatPendingAttachmentSnapshot(scope)).toEqual([])
    expect(latest().imageAttachments).toEqual([])
    expect(readNativeChatComposerDraft(scope).text).toBe(edit ? 'original' : '')
    expect(container.querySelector('[data-notice]')?.textContent).toBe(
      "Couldn't read the dropped files."
    )
    if (edit) {
      discardNativeChatQueuedEdit(edit)
    }
  }
)
