import { isValidElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { RuntimeImportProgressHandlers } from '@/runtime/runtime-upload-progress-tracker'
import type { ImportItemResult } from '../../../../shared/filesystem-import-result-types'

const mocks = vi.hoisted(() => {
  const listeners = new Set<(state: { activeWorktreeId: string | null }) => void>()
  const state: {
    activeWorktreeId: string | null
    worktreesByRepo: Record<
      string,
      { id: string; displayName: string; branch: string; path: string }[]
    >
  } = {
    activeWorktreeId: 'wt-a',
    worktreesByRepo: {
      'repo-a': [{ id: 'wt-a', displayName: 'ux-polish', branch: '', path: '/srv/a' }]
    }
  }
  const panel: { element: unknown } = { element: null }
  return {
    store: { state, listeners },
    panel,
    runImport: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.store.state,
    subscribe: (listener: (state: { activeWorktreeId: string | null }) => void) => {
      mocks.store.listeners.add(listener)
      return () => mocks.store.listeners.delete(listener)
    }
  }
}))
vi.mock('sonner', () => ({
  toast: {
    custom: vi.fn((render: () => unknown, options?: { id?: string | number }) => {
      mocks.panel.element = render()
      return options?.id ?? 'panel'
    }),
    dismiss: vi.fn(),
    error: vi.fn(),
    message: vi.fn()
  }
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'session-1' }))
vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: (
    _context: unknown,
    _paths: string[],
    _destination: string,
    options: { progress: RuntimeImportProgressHandlers }
  ) => mocks.runImport(options.progress)
}))
vi.mock('./terminal-drop-paste', () => ({ pasteResolvedDropPaths: vi.fn() }))
vi.mock('./TerminalDropUploadToast', () => ({ TerminalDropUploadToast: () => null }))

import { getRuntimeUploadSession } from '@/runtime/runtime-upload-session-state'
import { uploadRuntimeDropPaths } from './terminal-runtime-drop-upload'

function setActiveWorktree(activeWorktreeId: string | null): void {
  mocks.store.state = { ...mocks.store.state, activeWorktreeId }
  for (const listener of mocks.store.listeners) {
    listener(mocks.store.state)
  }
}

const row = { uploadId: 'up-1', name: 'clip.mp4', totalBytes: 10, sourcePath: '/local/clip.mp4' }
const imported: ImportItemResult = {
  sourcePath: '/local/clip.mp4',
  status: 'imported',
  destPath: '/srv/a/.orca/drops/clip.mp4',
  kind: 'file',
  renamed: false
}

type PaneHandles = Pick<
  Parameters<typeof uploadRuntimeDropPaths>[0],
  'dropTarget' | 'manager' | 'paneTransports' | 'pane'
>
const fakePaneHandles = { dropTarget: {}, manager: {}, paneTransports: new Map(), pane: {} }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pasteResolvedDropPaths is mocked, so these pane handles are passed through and never read.
const paneHandles = fakePaneHandles as unknown as PaneHandles

function dropArgs(dataPaths: string[]): Parameters<typeof uploadRuntimeDropPaths>[0] {
  return {
    ...paneHandles,
    dataPaths,
    tabId: 'tab-1',
    worktreePath: '/srv/a',
    runtimeEnvironmentId: 'env-1',
    settings: null,
    worktreeId: 'wt-a'
  }
}

/** Presses a row's cancel button on the panel that is currently shown. */
function cancelPanelRow(uploadId: string): void {
  const panel = mocks.panel.element
  if (!isValidElement<{ onCancel: (uploadId: string) => void }>(panel)) {
    throw new Error('no upload panel is shown')
  }
  panel.props.onCancel(uploadId)
}

/** Runs one single-file drop; `during` fires after the panel opened, before the upload ends. */
function dropOneFile(during: () => void = () => {}): Promise<void> {
  mocks.runImport.mockImplementation(async (progress: RuntimeImportProgressHandlers) => {
    progress.onStart([row])
    during()
    progress.onRowSettled(row.uploadId, 'done')
    progress.onFinish()
    return { results: [imported] }
  })
  return uploadRuntimeDropPaths(dropArgs(['/local/clip.mp4']))
}

describe('uploadRuntimeDropPaths panel scope', () => {
  beforeEach(() => {
    mocks.store.state = { ...mocks.store.state, activeWorktreeId: 'wt-a' }
    mocks.store.listeners.clear()
    vi.mocked(toast.custom).mockClear()
    vi.mocked(toast.dismiss).mockClear()
    vi.mocked(toast.error).mockClear()
  })

  it('keeps the panel off a workspace the user is not looking at', async () => {
    setActiveWorktree('wt-b')

    await dropOneFile()

    expect(toast.custom).not.toHaveBeenCalled()
    // Nothing is left to replay a "done" notice on return.
    expect(getRuntimeUploadSession('session-1')).toBeUndefined()
    expect(mocks.store.listeners.size).toBe(0)
  })

  it('hides the panel on switching away and brings it back on return', async () => {
    await dropOneFile(() => {
      expect(toast.custom).toHaveBeenCalledTimes(1)
      setActiveWorktree('wt-b')
      expect(toast.dismiss).toHaveBeenCalledWith('panel')
      setActiveWorktree('wt-a')
    })

    expect(toast.custom).toHaveBeenCalledTimes(2)
    // A fresh toast, not an update of the one sonner is animating out.
    expect(vi.mocked(toast.custom).mock.calls[1]?.[1]).not.toHaveProperty('id')
    // Still shown, so the panel keeps its outcome hold before closing itself.
    expect(getRuntimeUploadSession('session-1')?.settled).toBe(true)
  })

  it('ends a finished drop when the user leaves during the outcome hold', async () => {
    await dropOneFile()
    expect(getRuntimeUploadSession('session-1')?.settled).toBe(true)

    setActiveWorktree('wt-b')

    expect(getRuntimeUploadSession('session-1')).toBeUndefined()
    expect(mocks.store.listeners.size).toBe(0)
  })

  it('still reports a failed copy when another copy of the same path was cancelled', async () => {
    vi.stubGlobal('window', { api: { fs: { cancelRuntimeUpload: vi.fn(async () => {}) } } })
    const copies = [
      { ...row, uploadId: 'up-1' },
      { ...row, uploadId: 'up-2' }
    ]
    mocks.runImport.mockImplementation(async (progress: RuntimeImportProgressHandlers) => {
      progress.onStart(copies)
      cancelPanelRow('up-1')
      progress.onFinish()
      // Mirrors the import client, which marks only the cancelled copy.
      const results: ImportItemResult[] = copies.map(({ uploadId }) => ({
        sourcePath: row.sourcePath,
        status: 'failed',
        reason: 'disk full',
        ...(progress.isCancelled?.(uploadId) ? { cancelled: true } : {})
      }))
      return { results }
    })

    await uploadRuntimeDropPaths(dropArgs([row.sourcePath, row.sourcePath]))

    expect(toast.error).toHaveBeenCalledWith('Failed to upload 1 file.', {
      description: undefined
    })
    vi.unstubAllGlobals()
  })
})
