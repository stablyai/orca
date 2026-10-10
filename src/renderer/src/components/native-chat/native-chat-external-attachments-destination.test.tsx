// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AttachmentUploadModule from './native-chat-attachment-upload'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import {
  clearNativeChatAttachmentCacheForTests,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'

const mocks = vi.hoisted(() => {
  const state: {
    owner: NativeChatAttachmentOwner
    remoteTarget: boolean
    stat: ReturnType<typeof vi.fn>
    upload: ReturnType<typeof vi.fn>
    tabsByWorktree: Record<string, { id: string }[]>
  } = {
    owner: { kind: 'local' },
    remoteTarget: false,
    stat: vi.fn(),
    upload: vi.fn(),
    tabsByWorktree: { 'workspace-1': [{ id: 'tab-1' }] }
  }
  return state
})
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ tabsByWorktree: mocks.tabsByWorktree }) }
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => mocks.remoteTarget
}))
vi.mock('./native-chat-attachment-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentUploadModule>()),
  resolveNativeChatAttachmentOwner: () => mocks.owner,
  resolveNativeChatAttachmentOwnerForWorktree: () => mocks.owner,
  uploadNativeChatAttachmentPaths: mocks.upload
}))

type Api = ReturnType<typeof useNativeChatExternalAttachments> &
  ReturnType<typeof useNativeChatComposerAttachments>
let api: Api | undefined
let root: Root
let container: HTMLDivElement
let composing = true

function Probe({ worktreeId }: { worktreeId?: string }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachments = useNativeChatComposerAttachments({
    attachmentScopeKey: 'drop-test',
    caret,
    disabled: false,
    isComposing: () => composing,
    resolveTarget: () => ({ ptyId: 'pty-1', settings: { activeRuntimeEnvironmentId: null } }),
    textareaRef,
    setCaret,
    setDraft,
    setNotice
  })
  const external = useNativeChatExternalAttachments({
    terminalTabId: 'tab-1',
    structuredWorktreeId: worktreeId,
    disabled: false,
    attachResolvedPaths: attachments.attachResolvedPaths,
    pendingChips: attachments.pendingChips,
    setNotice
  })
  api = { ...attachments, ...external }
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

async function render(worktreeId?: string): Promise<void> {
  await act(async () => root.render(<Probe worktreeId={worktreeId} />))
}

beforeEach(() => {
  api = undefined
  composing = true
  mocks.owner = { kind: 'local' }
  mocks.remoteTarget = false
  mocks.stat.mockReset().mockResolvedValue(undefined)
  mocks.upload.mockReset().mockResolvedValue(['/remote/file.txt'])
  mocks.tabsByWorktree = { 'workspace-1': [{ id: 'tab-1' }] }
  vi.stubGlobal('api', { fs: { stat: mocks.stat } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  clearNativeChatAttachmentCacheForTests()
  vi.unstubAllGlobals()
})

describe('OS attachment destination through input-method composition', () => {
  it.each(['workspace', 'host', 'ssh-generation', 'terminal-workspace'])(
    'refuses queued files after the %s changes',
    async (change) => {
      if (change === 'ssh-generation') {
        mocks.owner = {
          kind: 'ssh',
          connectionId: 'ssh-1',
          worktreePath: '/remote',
          expectedExecutionHostId: 'ssh:ssh-1',
          expectedSshTargetId: 'ssh-1',
          expectedSshConnectionGeneration: 1
        }
      }
      await render(change === 'terminal-workspace' ? undefined : 'workspace-1')
      await act(async () => latest().attachExternalPaths(['/local/file.txt', '/local/image.png']))
      expect(container.querySelector('[data-draft]')?.textContent).toBe('')
      if (change === 'workspace') {
        await render('workspace-2')
      }
      if (change === 'host') {
        mocks.owner = { kind: 'runtime' }
      }
      if (change === 'ssh-generation' && mocks.owner.kind === 'ssh') {
        mocks.owner = { ...mocks.owner, expectedSshConnectionGeneration: 2 }
      }
      if (change === 'terminal-workspace') {
        mocks.tabsByWorktree = { 'workspace-1': [] }
      }
      composing = false
      act(() => latest().flushPendingAttachments())
      expect(container.querySelector('[data-draft]')?.textContent).toBe('')
      expect(latest().imageAttachments).toEqual([])
      expect(container.querySelector('[data-notice]')?.textContent).toBe(
        'This workspace changed hosts while attaching — drop the files again.'
      )
    }
  )

  it('attaches an unchanged queued OS destination normally', async () => {
    await render('workspace-1')
    await act(async () => latest().attachExternalPaths(['/local/file.txt']))
    composing = false
    act(() => latest().flushPendingAttachments())
    expect(container.querySelector('[data-draft]')?.textContent).toBe('@/local/file.txt ')
  })

  it('refuses an obsolete SSH drop and attaches the retry once during the same composition', async () => {
    mocks.owner = {
      kind: 'ssh',
      connectionId: 'ssh-1',
      worktreePath: '/remote',
      expectedExecutionHostId: 'ssh:ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 1
    }
    mocks.upload
      .mockResolvedValueOnce(['/remote/a.txt', '/remote/a.png'])
      .mockResolvedValueOnce(['/remote/b.txt', '/remote/b.png'])
    await render('workspace-1')
    await act(async () => latest().attachExternalPaths(['/local/a.txt', '/local/a.png']))
    mocks.owner = { ...mocks.owner, expectedSshConnectionGeneration: 2 }
    await act(async () => latest().attachExternalPaths(['/local/b.txt', '/local/b.png']))
    expect(container.querySelector('[data-draft]')?.textContent).toBe('')
    composing = false
    act(() => {
      latest().flushPendingAttachments()
      latest().flushPendingAttachments()
    })
    expect(container.querySelector('[data-draft]')?.textContent).toBe('@/remote/b.txt ')
    expect(latest().imageAttachments).toEqual([
      expect.objectContaining({ path: '/remote/b.png', connectionId: 'ssh-1' })
    ])
    expect(container.querySelector('[data-notice]')?.textContent).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })

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
})
