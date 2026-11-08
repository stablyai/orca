// @vitest-environment happy-dom

import type * as AttachmentOwnerModule from '../uploads/native-chat-attachment-owner'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useRef, useState } from 'react'

import type { NativeChatComposerInput } from '../../composer/editor/native-chat-composer-input'
import { NativeChatPromptEditor } from '../../composer/editor/NativeChatPromptEditor'
import { useNativeChatFileDrops } from './use-native-chat-file-drops'
import { NativeChatPaneFileDropSurface } from './NativeChatPaneFileDropSurface'
import { useNewWorkspaceComposerFileDrop } from '../../../new-workspace/use-new-workspace-composer-file-drop'
import { NativeChatImageAttachmentPreview } from '../chips/NativeChatImageAttachmentPreview'
import '../../../editor/document-images/useLocalImageSrc'
import { resetLocalImageCacheState as resetLocalImageSrcStateForTests } from '../../../editor/document-images/local-image-src-cache'
import { clearNativeChatAttachmentCacheForTests } from '../../drafts/native-chat-draft-reset'
import { readNativeChatAttachmentCache } from '../chips/native-chat-attachment-draft'
import { useNativeChatComposerAttachments } from '../chips/use-native-chat-composer-attachments'
import type * as RemoteRuntimePtyIdModule from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

const electron = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  getPathForFile: vi.fn((file: File) => `/repro/${file.name}`)
}))

const intake = vi.hoisted(() => {
  const owner: { kind: string } = { kind: 'local' }
  return {
    owner,
    stat: vi.fn(),
    readFile: vi.fn(),
    prepare: vi.fn(async ({ paths }: { paths: string[] }) => ({ paths, failures: [] })),
    pick: vi.fn()
  }
})
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: () => unknown) => select(), {
    getState: () => ({ tabsByWorktree: {} })
  })
}))
// Keeps the real notice strings so the silent-failure guards assert what users see.
vi.mock('../uploads/native-chat-attachment-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentOwnerModule>()),
  resolveNativeChatAttachmentOwner: () => intake.owner
}))

vi.mock('electron', () => ({
  ipcRenderer: electron,
  webUtils: { getPathForFile: electron.getPathForFile }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name]))
}))
vi.mock(
  '../../../../../../shared/remote-runtime/remote-runtime-pty-id',
  async (importOriginal) => ({
    ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
    isRemoteRuntimePtyId: () => false
  })
)

import { installOsFileDropCancellationGuard } from '@/lib/os-file-drop-cancellation-guard'

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
      {attachments.imageAttachments.map((attachment, index) => (
        <NativeChatImageAttachmentPreview
          key={attachment.id}
          attachment={attachment}
          number={index + 1}
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
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        shell: { pickAttachments: intake.pick },
        fs: {
          ...intake,
          getPathForFile: electron.getPathForFile,
          prepareDroppedPaths: intake.prepare
        }
      }
    })
  })

  let disposeGuard: (() => void) | undefined
  beforeEach(() => {
    disposeGuard = installOsFileDropCancellationGuard()
    intake.owner = { kind: 'local' }
    electron.getPathForFile.mockReset().mockImplementation((file: File) => `/repro/${file.name}`)
    intake.stat.mockReset().mockResolvedValue(undefined)
    intake.readFile.mockReset().mockResolvedValue({ content: '', isBinary: false })
    intake.prepare.mockReset().mockImplementation(async ({ paths }) => ({ paths, failures: [] }))
    intake.pick.mockReset()
    vi.stubGlobal('IntersectionObserver', undefined)
  })

  afterEach(() => {
    disposeGuard?.()
    cleanup()
    resetLocalImageSrcStateForTests()
    vi.unstubAllGlobals()
    clearNativeChatAttachmentCacheForTests()
    electron.send.mockClear()
    vi.clearAllMocks()
  })
  it('captures the host before preparation and refuses a changed host before upload', async () => {
    const gate = Promise.withResolvers<{ paths: string[]; failures: never[] }>()
    intake.prepare.mockImplementationOnce(() => gate.promise)
    const view = render(<ComposerProbe pane="chat-a" />)
    await dropTwoImages(view.container.querySelector('.ProseMirror')!)
    intake.owner = { kind: 'remote' }
    await act(async () => gate.resolve({ paths: ['/prepared/a.png'], failures: [] }))
    expect(intake.stat).not.toHaveBeenCalled()
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

  it('notices an OS drop whose owner changes while checking the files', async () => {
    intake.stat.mockImplementation(async () => {
      intake.owner = { kind: 'remote' }
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
    const shown = [...view.container.querySelectorAll('output:not([data-notice])')].map(
      (output) => output.textContent
    )
    expect(shown).toEqual([
      JSON.stringify(['/repro/first.png', '/repro/second.png']),
      JSON.stringify(['/repro/first.png', '/repro/second.png'])
    ])
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
})
