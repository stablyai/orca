// @vitest-environment happy-dom
import type * as AttachmentOwnerModule from '../uploads/native-chat-attachment-owner'
import type * as SessionAttachmentUploadModule from '../uploads/native-chat-session-attachment-upload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  holdBrowserAttachmentFiles,
  takeBrowserAttachmentFile
} from '@/lib/browser-attachment-files'

const mocks = vi.hoisted(() => ({
  storeState: { tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] } },
  stat: vi.fn(),
  resolveNativeChatAttachmentOwner: vi.fn(),
  resolveNativeChatAttachmentOwnerForWorktree: vi.fn(),
  prepareNativeChatSessionAttachmentUpload: vi.fn(),
  uploadNativeChatSessionAttachmentPaths: vi.fn(),
  toastLoading: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { loading: mocks.toastLoading, dismiss: vi.fn(), error: vi.fn(), message: vi.fn() }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.storeState }
}))

// Keep real notice exports so mocks cannot hide wording regressions or newly added notices.
vi.mock('../uploads/native-chat-attachment-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentOwnerModule>()),
  resolveNativeChatAttachmentOwner: mocks.resolveNativeChatAttachmentOwner,
  resolveNativeChatAttachmentOwnerForWorktree: mocks.resolveNativeChatAttachmentOwnerForWorktree
}))

vi.mock('../uploads/native-chat-session-attachment-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionAttachmentUploadModule>()),
  prepareNativeChatSessionAttachmentUpload: mocks.prepareNativeChatSessionAttachmentUpload,
  uploadNativeChatSessionAttachmentPaths: mocks.uploadNativeChatSessionAttachmentPaths
}))

import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import type { NativeChatPendingAttachmentChips } from './native-chat-session-attachment-drop'
import type { NativeChatStructuredAttachmentSession } from '../uploads/native-chat-attachment-owner'

type HookApi = ReturnType<typeof useNativeChatExternalAttachments>

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function noPendingChips(): NativeChatPendingAttachmentChips {
  let id = 0
  return {
    begin: vi.fn(() => String(++id)),
    resolve: vi.fn(() => true),
    drop: vi.fn(() => true),
    attachReferences: vi.fn(() => true)
  }
}

function Probe({
  disabled,
  structuredWorktreeId,
  structuredSession,
  attachResolvedPaths,
  pendingChips,
  setNotice,
  onReady
}: {
  disabled: boolean
  structuredWorktreeId?: string
  structuredSession?: NativeChatStructuredAttachmentSession
  attachResolvedPaths: (paths: string[]) => void
  pendingChips: NativeChatPendingAttachmentChips
  setNotice: (notice: string | null) => void
  onReady: (api: HookApi) => void
}): null {
  onReady(
    useNativeChatExternalAttachments({
      terminalTabId: 'tab-1',
      structuredWorktreeId,
      structuredSession,
      disabled,
      attachResolvedPaths,
      pendingChips,
      setNotice
    })
  )
  return null
}

let root: Root | null = null

async function renderProbe(args: {
  disabled?: boolean
  structuredWorktreeId?: string
  structuredSession?: NativeChatStructuredAttachmentSession
  attachResolvedPaths: (paths: string[]) => void
  pendingChips?: NativeChatPendingAttachmentChips
  setNotice?: (notice: string | null) => void
}): Promise<{
  latest: () => HookApi
  setDisabled: (disabled: boolean) => Promise<void>
  setStructuredWorktreeId: (structuredWorktreeId: string) => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.append(container)
  let api: HookApi | null = null
  root = createRoot(container)
  let disabled = args.disabled ?? false
  let structuredWorktreeId = args.structuredWorktreeId
  const render = async (): Promise<void> => {
    await act(async () => {
      root?.render(
        createElement(Probe, {
          disabled,
          structuredWorktreeId,
          structuredSession: args.structuredSession,
          attachResolvedPaths: args.attachResolvedPaths,
          pendingChips: args.pendingChips ?? noPendingChips(),
          setNotice: args.setNotice ?? (() => {}),
          onReady: (next) => {
            api = next
          }
        })
      )
    })
  }
  await render()
  return {
    latest: () => {
      if (!api) {
        throw new Error('Probe did not render')
      }
      return api
    },
    setDisabled: async (next) => {
      disabled = next
      await render()
    },
    setStructuredWorktreeId: async (next) => {
      structuredWorktreeId = next
      await render()
    }
  }
}

beforeEach(() => {
  mocks.stat.mockReset().mockResolvedValue(undefined)
  mocks.resolveNativeChatAttachmentOwnerForWorktree.mockReset().mockReturnValue({ kind: 'local' })
  vi.stubGlobal('api', { fs: { stat: mocks.stat } })
})

afterEach(() => {
  root?.unmount()
  root = null
  vi.clearAllMocks()
})

describe('useNativeChatExternalAttachments', () => {
  // Recheck after the final path too; otherwise a one-file drop can attach after its host owner changes.
  it('reports a one-file drop whose owner changes during its file check', async () => {
    const fileCheck = deferred<void>()
    let owner: { kind: 'local' } | { kind: 'remote' } = { kind: 'local' }
    mocks.resolveNativeChatAttachmentOwner.mockImplementation(() => owner)
    mocks.stat.mockReturnValueOnce(fileCheck.promise)
    const attachResolvedPaths = vi.fn()
    const notices: (string | null)[] = []
    const probe = await renderProbe({
      attachResolvedPaths,
      setNotice: (notice) => notices.push(notice)
    })

    act(() => probe.latest().attachExternalPaths(['/external/only.pdf']))
    owner = { kind: 'remote' }
    await act(async () => fileCheck.resolve())

    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(notices.at(-1)).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })

  // Two workspaces can share local ownership; recheck the pane’s workspace, not only host identity.
  it('does not attach when the pane changes workspace during the file check', async () => {
    const fileCheck = deferred<void>()
    mocks.stat.mockReturnValueOnce(fileCheck.promise)
    const attachResolvedPaths = vi.fn()
    const notices: (string | null)[] = []
    const probe = await renderProbe({
      structuredWorktreeId: 'worktree-1',
      attachResolvedPaths,
      setNotice: (notice) => notices.push(notice)
    })

    act(() => probe.latest().attachExternalPaths(['/external/only.pdf']))
    await probe.setStructuredWorktreeId('worktree-2')
    await act(async () => fileCheck.resolve())

    expect(attachResolvedPaths).not.toHaveBeenCalled()
    expect(notices.at(-1)).toBe(
      'This workspace changed hosts while attaching — drop the files again.'
    )
  })

  it('releases browser files a refused attach held, so none stay pinned in the page', async () => {
    mocks.resolveNativeChatAttachmentOwner.mockReturnValue({ kind: 'remote' })
    const file = new File(['a'], 'a.txt')
    const [token] = holdBrowserAttachmentFiles([file])
    const probe = await renderProbe({ attachResolvedPaths: vi.fn(), setNotice: vi.fn() })
    await act(async () => {
      probe.latest().attachExternalPaths([token!])
    })
    expect(takeBrowserAttachmentFile(token!)).toBeNull()
  })

  it('releases browser files a picker returns to an already disabled composer', async () => {
    const [token] = holdBrowserAttachmentFiles([new File(['a'], 'a.txt')])
    const probe = await renderProbe({ disabled: true, attachResolvedPaths: vi.fn() })

    act(() => probe.latest().attachExternalPaths([token!]))

    expect(takeBrowserAttachmentFile(token!)).toBeNull()
  })
})
