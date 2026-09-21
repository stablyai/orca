// @vitest-environment happy-dom

import { EventEmitter } from 'node:events'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import { resetLocalImageSrcStateForTests } from '../editor/useLocalImageSrc'
import { useComposerDropListener } from '../../hooks/composer-state/composer-drop-listener'
import type { NativeFileDropPayload } from '../../../../shared/native-file-drop'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'
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
  authorizeExternalPath: vi.fn(),
  readFile: vi.fn(),
  upload: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./native-chat-attachment-upload', () => ({
  resolveNativeChatAttachmentOwner: () => intake.owner,
  uploadNativeChatAttachmentPaths: intake.upload
}))

vi.mock('electron', () => ({
  ipcRenderer: electron,
  webUtils: { getPathForFile: electron.getPathForFile }
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ isRemoteRuntimePtyId: () => false }))

import {
  installNativeFileDropHandlers,
  subscribeNativeFileDrop
} from '../../../../preload/preload-runtime-support'

// Uses the production drop listener, subscriber fan-out, attachment hook, and scope cache.
function ComposerProbe({ pane, hidden = false }: { pane: string; hidden?: boolean }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachments = useNativeChatComposerAttachments({
    attachmentScopeKey: pane,
    allowWithoutTarget: true,
    caret: 0,
    disabled: false,
    isComposing: () => false,
    resolveTarget: () => null,
    textareaRef,
    setCaret: () => {},
    setDraft: () => {},
    setNotice: () => {}
  })
  const { attachExternalPaths } = useNativeChatExternalAttachments({
    terminalTabId: pane,
    disabled: false,
    attachResolvedPaths: attachments.attachResolvedPaths,
    setNotice: () => {}
  })
  useNativeChatFileAttachmentActions(pane, attachExternalPaths)
  return (
    <div data-pane={pane} style={{ display: hidden ? 'none' : 'block' }}>
      <textarea
        ref={textareaRef}
        data-native-file-drop-target="composer"
        data-composer-scope-key={pane}
      />
      {attachments.imageAttachments.map((attachment) => (
        <NativeChatImageAttachmentPreview
          key={attachment.id}
          attachment={attachment}
          onRemove={() => {}}
        />
      ))}
      <output>{JSON.stringify(attachments.imageAttachments.map(({ path }) => path))}</output>
    </div>
  )
}

async function dropTwoImages(target: Element): Promise<void> {
  const event = new Event('drop', { bubbles: true, cancelable: true })
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

function WorkspaceComposerProbe({ onDrop }: { onDrop: (paths: string[]) => void }) {
  useComposerDropListener(onDrop)
  return <div data-native-file-drop-target="composer" data-workspace-composer="true" />
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
      value: { ui: { onFileDrop: subscribeNativeFileDrop }, fs: intake }
    })
    installNativeFileDropHandlers()
  })

  beforeEach(() => {
    intake.owner = { kind: 'local' }
    intake.authorizeExternalPath.mockReset().mockResolvedValue(undefined)
    intake.readFile.mockReset().mockResolvedValue({ content: '', isBinary: false })
    intake.upload.mockReset()
    vi.stubGlobal('IntersectionObserver', undefined)
  })

  afterEach(() => {
    cleanup()
    resetLocalImageSrcStateForTests()
    vi.unstubAllGlobals()
    clearNativeChatAttachmentCacheForTests()
    electron.send.mockClear()
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

    const target = view.container.querySelector('[data-pane="chat-a"] textarea')!
    await dropTwoImages(target)

    expect(electron.send).toHaveBeenCalledExactlyOnceWith('terminal:file-dropped-from-preload', {
      target: 'composer',
      scopeKey: 'chat-a',
      paths: ['/repro/first.png', '/repro/second.png']
    })
    expect(readNativeChatAttachmentCache('chat-a').map(({ path }) => path)).toEqual([
      '/repro/first.png',
      '/repro/second.png'
    ])
    expect(readNativeChatAttachmentCache('chat-b')).toEqual([])

    view.unmount()
    const returned = render(<ComposerProbe pane="chat-b" />)
    expect(returned.container.querySelector('output')?.textContent).toBe('[]')
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

    await dropTwoImages(view.container.querySelector('[data-pane="chat-a"] textarea')!)
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

  it('authorizes only dropped files before preview reads and leaves the other pane untouched', async () => {
    const authorized = new Set<string>()
    intake.authorizeExternalPath.mockImplementation(
      async ({ targetPath }: { targetPath: string }) => {
        authorized.add(targetPath)
      }
    )
    intake.readFile.mockImplementation(async ({ filePath }: { filePath: string }) => {
      if (!authorized.has(filePath)) {
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
    await dropTwoImages(view.container.querySelector('[data-pane="chat-a"] textarea')!)
    expect(await screen.findByRole('img', { name: 'first.png' })).toBeTruthy()
    expect(await screen.findByRole('img', { name: 'second.png' })).toBeTruthy()
    expect(intake.authorizeExternalPath.mock.calls).toEqual([
      [{ targetPath: '/repro/first.png' }],
      [{ targetPath: '/repro/second.png' }]
    ])
    expect(intake.readFile).toHaveBeenCalledTimes(2)
    expect(intake.upload).not.toHaveBeenCalled()
    expect(readNativeChatAttachmentCache('chat-a')).toHaveLength(2)
    expect(readNativeChatAttachmentCache('chat-b')).toEqual([])
    await expect(intake.readFile({ filePath: '/repro/sibling.png' })).rejects.toThrow(
      'Access denied'
    )
  })

  it('uploads once for the SSH drop owner without authorizing remote paths locally', async () => {
    intake.owner = { kind: 'ssh', connectionId: 'conn-1' }
    intake.upload.mockResolvedValue(['/remote/first.png', '/remote/second.png'])
    const view = render(
      <>
        <ComposerProbe pane="chat-a" />
        <ComposerProbe pane="chat-b" hidden />
      </>
    )
    await dropTwoImages(view.container.querySelector('[data-pane="chat-a"] textarea')!)
    expect(intake.upload).toHaveBeenCalledExactlyOnceWith(
      ['/repro/first.png', '/repro/second.png'],
      intake.owner
    )
    expect(intake.authorizeExternalPath).not.toHaveBeenCalled()
    expect(readNativeChatAttachmentCache('chat-a').map(({ path }) => path)).toEqual([
      '/remote/first.png',
      '/remote/second.png'
    ])
    expect(readNativeChatAttachmentCache('chat-b')).toEqual([])
  })

  // Mirrors the terminal target, whose leaf id sits inside its drop-target marker.
  it('reads a scope key published inside the drop-target marker', async () => {
    const view = render(
      <div data-native-file-drop-target="composer">
        <div data-composer-scope-key="chat-a">
          <span data-inner-drop-point="true" />
        </div>
      </div>
    )
    await dropTwoImages(view.container.querySelector('[data-inner-drop-point="true"]')!)
    expect(electron.send).toHaveBeenCalledExactlyOnceWith('terminal:file-dropped-from-preload', {
      target: 'composer',
      scopeKey: 'chat-a',
      paths: ['/repro/first.png', '/repro/second.png']
    })
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
