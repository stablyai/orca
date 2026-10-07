// @vitest-environment happy-dom

import { EventEmitter } from 'node:events'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import type * as AttachmentUploadModule from './native-chat-attachment-upload'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { useNativeChatFileDrops } from './use-native-chat-file-drops'
import { NativeChatPaneFileDropSurface } from './NativeChatPaneFileDropSurface'
import { useNewWorkspaceComposerFileDrop } from '../new-workspace/use-new-workspace-composer-file-drop'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import { toast } from 'sonner'
import { resetLocalImageSrcStateForTests } from '../editor/useLocalImageSrc'
import type { NativeFileDropPayload } from '../../../../shared/native-file-drop'
import {
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'

const electron = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  getPathForFile: vi.fn((file: File) => `/repro/${file.name}`)
}))

const intake = vi.hoisted(() => ({
  owner: { kind: 'local' } as { kind: string; connectionId?: string },
  stat: vi.fn(),
  readFile: vi.fn(),
  upload: vi.fn(),
  prepare: vi.fn(async ({ paths }: { paths: string[] }) => ({ paths, failures: [] })),
  pick: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ tabsByWorktree: {} }) } }))
// Keeps the real notice strings so the silent-failure guards assert what users see.
vi.mock('./native-chat-attachment-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentUploadModule>()),
  resolveNativeChatAttachmentOwner: () => intake.owner,
  uploadNativeChatAttachmentPaths: intake.upload
}))

vi.mock('electron', () => ({
  ipcRenderer: electron,
  webUtils: { getPathForFile: electron.getPathForFile }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ isRemoteRuntimePtyId: () => false }))

import {
  installNativeFileDropHandlers,
  subscribeNativeFileDrop
} from '../../../../preload/preload-runtime-support'

// Exercises real element delivery, path authorization and the draft attachment cache.
function ComposerBody({
  pane,
  draft = pane,
  hidden = false,
  disabled = false
}: {
  pane: string
  /** The draft's owner; a structured chat's composers share their conversation's. */
  draft?: string
  hidden?: boolean
  disabled?: boolean
}) {
  const textareaRef = useRef<NativeChatComposerInput>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const attachments = useNativeChatComposerAttachments({
    attachmentScopeKey: draft,
    allowWithoutTarget: true,
    caret: 0,
    disabled,
    isComposing: () => false,
    resolveTarget: () => null,
    textareaRef,
    setCaret: () => {},
    setDraft: () => {},
    setNotice
  })
  const { pickAttachments } = useNativeChatFileDrops({
    paneKey: pane,
    draftScopeKey: draft,
    targetPtyId: null,
    terminalTabId: pane,
    disabled,
    attachResolvedPaths: attachments.attachResolvedPaths,
    pendingChips: attachments.pendingChips,
    setNotice
  })
  return (
    <div data-pane={pane} style={{ display: hidden ? 'none' : 'block' }}>
      <div>
        <NativeChatPromptEditor
          scopeKey={draft}
          inputRef={textareaRef}
          initialValue="untouched draft"
          disabled={false}
          placeholder="Message"
          onChange={() => {}}
          onSelect={() => {}}
        />
      </div>
      {attachments.imageAttachments.map((attachment) => (
        <NativeChatImageAttachmentPreview
          key={attachment.id}
          attachment={attachment}
          onRemove={() => {}}
        />
      ))}
      <output>{JSON.stringify(attachments.imageAttachments.map(({ path }) => path))}</output>
      <button onClick={pickAttachments}>Attach to {pane}</button>
      <output data-notice={pane}>{notice}</output>
    </div>
  )
}

function ComposerProbe(props: React.ComponentProps<typeof ComposerBody>) {
  return (
    <NativeChatPaneFileDropSurface className="chat-pane">
      <ComposerBody {...props} />
    </NativeChatPaneFileDropSurface>
  )
}

/** The external-attach loop awaits once per path; drain those before asserting. */
async function settleAttachments(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function dropTwoImages(target: Element): Promise<void> {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'isTrusted', { value: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: ['Files'],
      files: [new File(['a'], 'first.png'), new File(['b'], 'second.png')]
    }
  })
  await act(async () => {
    target.dispatchEvent(event)
  })
}

function WorkspaceComposerProbe({
  onDrop
}: {
  onDrop: (paths: string[], current: () => boolean) => void
}) {
  const owner = useNewWorkspaceComposerFileDrop({
    projectPath: '/repo',
    hostId: 'local',
    connectionId: null,
    applyDrop: async (paths, current) => onDrop(paths, current)
  })
  return <div ref={owner} data-workspace-composer="true" />
}

describe('native chat composer drop scoping', () => {
  beforeAll(() => {
    const ipc = new EventEmitter()
    electron.on.mockImplementation((channel, listener) => ipc.on(channel, listener))
    electron.removeListener.mockImplementation((channel, listener) =>
      ipc.removeListener(channel, listener)
    )
    // Mirror registerFileDropRelay: one window-wide notification per valid drop.
    electron.send.mockImplementation((channel: string, payload: NativeFileDropPayload) => {
      if (channel === 'terminal:file-dropped-from-preload') {
        ipc.emit('terminal:file-drop', {}, payload)
      }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: { onFileDrop: subscribeNativeFileDrop },
        shell: { pickAttachments: intake.pick },
        fs: {
          ...intake,
          getPathForFile: electron.getPathForFile,
          prepareDroppedPaths: intake.prepare
        }
      }
    })
    installNativeFileDropHandlers()
    // Repeated preload setup must stay singleton or every OS drop is processed once per install.
    installNativeFileDropHandlers()
  })

  beforeEach(() => {
    intake.owner = { kind: 'local' }
    electron.getPathForFile.mockReset().mockImplementation((file: File) => `/repro/${file.name}`)
    intake.stat.mockReset().mockResolvedValue(undefined)
    intake.readFile.mockReset().mockResolvedValue({ content: '', isBinary: false })
    intake.upload.mockReset()
    intake.prepare.mockReset().mockImplementation(async ({ paths }) => ({ paths, failures: [] }))
    intake.pick.mockReset()
    vi.stubGlobal('IntersectionObserver', undefined)
  })

  afterEach(() => {
    cleanup()
    resetLocalImageSrcStateForTests()
    vi.unstubAllGlobals()
    clearNativeChatAttachmentCacheForTests()
    electron.send.mockClear()
    vi.clearAllMocks()
  })

  it('keeps the paperclip picker attached to its own chat', async () => {
    intake.pick.mockResolvedValue(['/picked/image.png'])
    const view = render(
      <>
        <ComposerProbe pane="chat-a" />
        <ComposerProbe pane="chat-b" hidden />
      </>
    )
    await act(async () => screen.getByText('Attach to chat-a').click())
    await settleAttachments()
    expect(intake.pick).toHaveBeenCalledOnce()
    expect(intake.stat).toHaveBeenCalledExactlyOnceWith({
      filePath: '/picked/image.png',
      access: { kind: 'user-file' }
    })
    expect(readNativeChatAttachmentCache('chat-a').map(({ path }) => path)).toEqual([
      '/picked/image.png'
    ])
    expect(readNativeChatAttachmentCache('chat-b')).toEqual([])
    expect(view.container.querySelector('[data-notice="chat-a"]')?.textContent).toBe('')
  })
  it('keeps a cancelled paperclip picker quiet', async () => {
    intake.pick.mockResolvedValue([])
    render(<ComposerProbe pane="chat-a" />)
    await act(async () => screen.getByText('Attach to chat-a').click())
    expect(intake.stat).not.toHaveBeenCalled()
    expect(readNativeChatAttachmentCache('chat-a')).toEqual([])
    expect(toast.error).not.toHaveBeenCalled()
  })
  it('captures the host before preparation and refuses a changed host before upload', async () => {
    const gate = Promise.withResolvers<{ paths: string[]; failures: never[] }>()
    intake.prepare.mockImplementationOnce(() => gate.promise)
    const view = render(<ComposerProbe pane="chat-a" />)
    await dropTwoImages(view.container.querySelector('.ProseMirror')!)
    intake.owner = { kind: 'ssh', connectionId: 'other-host' }
    await act(async () => gate.resolve({ paths: ['/prepared/a.png'], failures: [] }))
    expect(intake.stat).not.toHaveBeenCalled()
    expect(intake.upload).not.toHaveBeenCalled()
    expect(readNativeChatAttachmentCache('chat-a')).toEqual([])
  })
  it('refuses preparation captured for a draft that changed in the same pane', async () => {
    const gate = Promise.withResolvers<{ paths: string[]; failures: never[] }>()
    intake.prepare.mockImplementationOnce(() => gate.promise)
    const view = render(<ComposerProbe pane="chat-a" draft="session-a" />)
    await dropTwoImages(view.container.querySelector('.ProseMirror')!)
    view.rerender(<ComposerProbe pane="chat-a" draft="session-b" />)
    await act(async () => gate.resolve({ paths: ['/prepared/a.png'], failures: [] }))
    expect(readNativeChatAttachmentCache('session-a')).toEqual([])
    expect(readNativeChatAttachmentCache('session-b')).toEqual([])
    expect(intake.stat).not.toHaveBeenCalled()
  })

  // #15782: an OS drop that produces nothing must say so. Every assertion here
  // is about the absence of silence, not about which path was attached.
  it('reports an OS drop whose files carry no readable path', async () => {
    electron.getPathForFile.mockReturnValue('')
    const view = render(<ComposerProbe pane="chat-a" />)

    await dropTwoImages(view.container.querySelector('[data-pane="chat-a"] .ProseMirror')!)

    expect(toast.error).toHaveBeenCalledWith(
      "Orca couldn't read a path for the dropped files.",
      expect.any(Object)
    )
    expect(electron.send).not.toHaveBeenCalled()
    expect(readNativeChatAttachmentCache('chat-a')).toEqual([])
  })

  it('notices an OS drop whose every path is unreadable', async () => {
    intake.stat.mockRejectedValue(new Error('denied'))
    const view = render(<ComposerProbe pane="chat-a" />)

    await dropTwoImages(view.container.querySelector('[data-pane="chat-a"] .ProseMirror')!)
    await settleAttachments()

    expect(view.container.querySelector('[data-notice="chat-a"]')?.textContent).toBe(
      "Couldn't read the dropped files."
    )
    expect(readNativeChatAttachmentCache('chat-a')).toEqual([])
  })

  it('notices an OS drop whose owner changes while checking the files', async () => {
    intake.stat.mockImplementation(async () => {
      intake.owner = { kind: 'ssh', connectionId: 'conn-1' }
    })
    const view = render(<ComposerProbe pane="chat-a" />)

    await dropTwoImages(view.container.querySelector('[data-pane="chat-a"] .ProseMirror')!)
    await settleAttachments()

    expect(view.container.querySelector('[data-notice="chat-a"]')?.textContent).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
    expect(readNativeChatAttachmentCache('chat-a')).toEqual([])
  })

  it('attaches only to the dropped pane and leaves a hidden pane clean on remount', async () => {
    const view = render(
      <>
        <ComposerProbe pane="chat-a" />
        <ComposerProbe pane="chat-b" hidden />
      </>
    )
    expect(readNativeChatAttachmentCache('chat-a')).toEqual([])
    expect(readNativeChatAttachmentCache('chat-b')).toEqual([])

    const target = view.container.querySelector('[data-pane="chat-a"] .ProseMirror')!
    await dropTwoImages(target)

    expect(electron.send).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-composer-scope-key]')).toBeNull()
    expect(readNativeChatAttachmentCache('chat-a').map(({ path }) => path)).toEqual([
      '/repro/first.png',
      '/repro/second.png'
    ])
    expect(readNativeChatAttachmentCache('chat-b')).toEqual([])
    expect(target.textContent).toBe('untouched draft')

    view.unmount()
    const returned = render(<ComposerProbe pane="chat-b" />)
    expect(returned.container.querySelector('output')?.textContent).toBe('[]')
  })

  it('attaches a drop once, from the pane it landed on, when two panes share a conversation’s draft', async () => {
    const view = render(
      <>
        <ComposerProbe pane="chat-a" draft="agent-session:s1" />
        <ComposerProbe pane="chat-b" draft="agent-session:s1" />
      </>
    )

    await dropTwoImages(view.container.querySelector('[data-pane="chat-a"] .ProseMirror')!)
    await settleAttachments()

    expect(electron.send).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-composer-scope-key]')).toBeNull()
    expect(readNativeChatAttachmentCache('agent-session:s1').map(({ path }) => path)).toEqual([
      '/repro/first.png',
      '/repro/second.png'
    ])
    // Both panes show the one shared draft.
    const shown = [...view.container.querySelectorAll('output:not([data-notice])')].map(
      (output) => output.textContent
    )
    expect(shown).toEqual([
      JSON.stringify(['/repro/first.png', '/repro/second.png']),
      JSON.stringify(['/repro/first.png', '/repro/second.png'])
    ])
  })

  it('keeps a drop into an unscoped composer out of every chat pane', async () => {
    const view = render(
      <>
        <ComposerProbe pane="chat-a" />
        <ComposerProbe pane="chat-b" hidden />
        <div data-native-file-drop-target="composer" data-unscoped-composer="true" />
      </>
    )
    await dropTwoImages(view.container.querySelector('[data-unscoped-composer="true"]')!)
    expect(electron.send).toHaveBeenCalledExactlyOnceWith('terminal:file-dropped-from-preload', {
      target: 'composer',
      paths: ['/repro/first.png', '/repro/second.png']
    })
    expect(readNativeChatAttachmentCache('chat-a')).toEqual([])
    expect(readNativeChatAttachmentCache('chat-b')).toEqual([])
  })

  it('isolates native chat drops from the workspace composer while preserving workspace drops', async () => {
    const workspaceDrop = vi.fn()
    const view = render(
      <>
        <ComposerProbe pane="chat-a" />
        <ComposerProbe pane="chat-b" />
        <WorkspaceComposerProbe onDrop={workspaceDrop} />
      </>
    )

    await dropTwoImages(view.container.querySelector('[data-pane="chat-a"] .ProseMirror')!)
    expect(workspaceDrop).not.toHaveBeenCalled()
    expect(readNativeChatAttachmentCache('chat-b')).toEqual([])
    expect(readNativeChatAttachmentCache('chat-a').map(({ path }) => path)).toEqual([
      '/repro/first.png',
      '/repro/second.png'
    ])

    await dropTwoImages(view.container.querySelector('[data-workspace-composer="true"]')!)
    expect(workspaceDrop).toHaveBeenCalledExactlyOnceWith(
      ['/repro/first.png', '/repro/second.png'],
      expect.any(Function)
    )
    expect(readNativeChatAttachmentCache('chat-a').map(({ path }) => path)).toEqual([
      '/repro/first.png',
      '/repro/second.png'
    ])
    expect(readNativeChatAttachmentCache('chat-b')).toEqual([])
  })

  it('previews dropped files as chat images and leaves the other pane untouched', async () => {
    intake.readFile.mockImplementation(async ({ access }: { access?: { kind: string } }) => {
      if (access?.kind !== 'chat-image') {
        throw new Error('Access denied: path resolves outside allowed directories')
      }
      return { content: 'AA==', isBinary: true, mimeType: 'image/png' }
    })
    await expect(intake.readFile({ filePath: '/repro/first.png' })).rejects.toThrow('Access denied')
    intake.readFile.mockClear()
    const view = render(
      <>
        <ComposerProbe pane="chat-a" />
        <ComposerProbe pane="chat-b" hidden />
      </>
    )
    await dropTwoImages(view.container.querySelector('[data-pane="chat-a"] .ProseMirror')!)
    expect(await screen.findByRole('img', { name: 'first.png' })).toBeTruthy()
    expect(await screen.findByRole('img', { name: 'second.png' })).toBeTruthy()
    expect(intake.stat.mock.calls).toEqual([
      [{ filePath: '/repro/first.png', access: { kind: 'user-file' } }],
      [{ filePath: '/repro/second.png', access: { kind: 'user-file' } }]
    ])
    expect(intake.readFile).toHaveBeenCalledTimes(2)
    expect(intake.upload).not.toHaveBeenCalled()
    expect(readNativeChatAttachmentCache('chat-a')).toHaveLength(2)
    expect(readNativeChatAttachmentCache('chat-b')).toEqual([])
    await expect(intake.readFile({ filePath: '/repro/sibling.png' })).rejects.toThrow(
      'Access denied'
    )
  })

  it('uploads once for the SSH drop owner without checking remote paths locally', async () => {
    intake.owner = { kind: 'ssh', connectionId: 'conn-1' }
    intake.upload.mockResolvedValue(['/remote/first.png', '/remote/second.png'])
    const view = render(
      <>
        <ComposerProbe pane="chat-a" />
        <ComposerProbe pane="chat-b" hidden />
      </>
    )
    await dropTwoImages(view.container.querySelector('[data-pane="chat-a"] .ProseMirror')!)
    expect(intake.upload).toHaveBeenCalledExactlyOnceWith(
      ['/repro/first.png', '/repro/second.png'],
      intake.owner
    )
    expect(intake.stat).not.toHaveBeenCalled()
    expect(readNativeChatAttachmentCache('chat-a').map(({ path }) => path)).toEqual([
      '/remote/first.png',
      '/remote/second.png'
    ])
    expect(readNativeChatAttachmentCache('chat-b')).toEqual([])
  })

  it('control: an editor-targeted drop does not attach images to either chat', async () => {
    const view = render(
      <>
        <ComposerProbe pane="chat-a" />
        <ComposerProbe pane="chat-b" hidden />
        <div data-native-file-drop-target="editor" />
      </>
    )
    await dropTwoImages(view.container.querySelector('[data-native-file-drop-target="editor"]')!)
    expect(electron.send).toHaveBeenCalledExactlyOnceWith('terminal:file-dropped-from-preload', {
      target: 'editor',
      paths: ['/repro/first.png', '/repro/second.png']
    })
    expect(readNativeChatAttachmentCache('chat-a')).toEqual([])
    expect(readNativeChatAttachmentCache('chat-b')).toEqual([])
  })
})
