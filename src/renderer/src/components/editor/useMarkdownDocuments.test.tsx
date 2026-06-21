// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/types'
import type { OpenFile } from '@/store/slices/editor'
import { useMarkdownDocuments } from './useMarkdownDocuments'

const mocks = vi.hoisted(() => ({
  createMissingMarkdownDocLinkDocument: vi.fn(),
  listRuntimeMarkdownDocuments: vi.fn(),
  openFile: vi.fn(),
  openMarkdownPreview: vi.fn(),
  onSave: vi.fn(),
  statRuntimePath: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  listRuntimeMarkdownDocuments: mocks.listRuntimeMarkdownDocuments,
  statRuntimePath: mocks.statRuntimePath
}))

vi.mock('./markdown-doc-link-create', () => ({
  createMissingMarkdownDocLinkDocument: mocks.createMissingMarkdownDocLinkDocument
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning
  }
}))

vi.mock('@/store', () => {
  const state = {
    openFile: mocks.openFile,
    openMarkdownPreview: mocks.openMarkdownPreview,
    settings: { activeRuntimeEnvironmentId: null },
    worktreesByRepo: {
      repo: [{ id: 'wt-1', path: '/repo', repoId: 'repo', name: 'main' }]
    }
  }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

type HookResult = ReturnType<typeof useMarkdownDocuments>

const activeFile: OpenFile = {
  filePath: '/repo/current.md',
  id: '/repo/current.md',
  isDirty: false,
  language: 'markdown',
  mode: 'edit',
  relativePath: 'current.md',
  runtimeEnvironmentId: null,
  worktreeId: 'wt-1'
}

let latestHook: HookResult | null = null
const roots: Root[] = []

function HookProbe(): null {
  latestHook = useMarkdownDocuments(activeFile, true, 'rich', mocks.onSave)
  return null
}

async function renderHookProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<HookProbe />)
  })
  await flushPromises()
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function hookResult(): HookResult {
  if (!latestHook) {
    throw new Error('Hook has not rendered')
  }
  return latestHook
}

const existingDocument: MarkdownDocument = {
  basename: 'Existing.md',
  filePath: '/repo/Existing.md',
  name: 'Existing',
  relativePath: 'Existing.md'
}

describe('useMarkdownDocuments', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    latestHook = null
    mocks.createMissingMarkdownDocLinkDocument.mockReset()
    mocks.listRuntimeMarkdownDocuments.mockReset()
    mocks.openFile.mockReset()
    mocks.openMarkdownPreview.mockReset()
    mocks.onSave.mockReset()
    mocks.statRuntimePath.mockReset()
    mocks.toastError.mockReset()
    mocks.toastInfo.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.toastWarning.mockReset()
    mocks.listRuntimeMarkdownDocuments.mockResolvedValue([])
    mocks.onSave.mockResolvedValue(undefined)
    mocks.statRuntimePath.mockResolvedValue({ isDirectory: false })
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
  })

  it('refreshes a stale document index before opening an existing doc link', async () => {
    mocks.listRuntimeMarkdownDocuments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([existingDocument])

    await renderHookProbe()

    hookResult().onOpenDocLink('Existing')
    await flushPromises()

    expect(mocks.openFile).toHaveBeenCalledWith({
      filePath: existingDocument.filePath,
      language: 'markdown',
      mode: 'edit',
      relativePath: existingDocument.relativePath,
      runtimeEnvironmentId: null,
      worktreeId: 'wt-1'
    })
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('warns when a doc link target is ambiguous', async () => {
    const firstMatch: MarkdownDocument = {
      basename: 'Topic.md',
      filePath: '/repo/notes/Topic.md',
      name: 'Topic',
      relativePath: 'notes/Topic.md'
    }
    const secondMatch: MarkdownDocument = {
      basename: 'Topic.md',
      filePath: '/repo/archive/Topic.md',
      name: 'Topic',
      relativePath: 'archive/Topic.md'
    }
    mocks.listRuntimeMarkdownDocuments.mockResolvedValue([firstMatch, secondMatch])

    await renderHookProbe()

    hookResult().onOpenDocLink('Topic')
    await flushPromises()

    expect(mocks.toastWarning).toHaveBeenCalledWith('Document link is ambiguous', {
      description: 'notes/Topic.md, archive/Topic.md'
    })
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('uses cached current documents when a doc-link refresh is superseded', async () => {
    let resolveDocLinkRefresh = (_documents: MarkdownDocument[]): void => {}
    let resolveSaveRefresh = (_documents: MarkdownDocument[]): void => {}
    const docLinkRefresh = new Promise<MarkdownDocument[]>((resolve) => {
      resolveDocLinkRefresh = resolve
    })
    const saveRefresh = new Promise<MarkdownDocument[]>((resolve) => {
      resolveSaveRefresh = resolve
    })
    mocks.listRuntimeMarkdownDocuments
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(docLinkRefresh)
      .mockReturnValueOnce(saveRefresh)

    await renderHookProbe()

    hookResult().onOpenDocLink('Existing')
    await flushPromises()
    const savePromise = hookResult().mdSave('# updated')
    await flushPromises()

    resolveSaveRefresh([existingDocument])
    await flushPromises()
    resolveDocLinkRefresh([])
    await flushPromises()
    await savePromise

    expect(mocks.openFile).toHaveBeenCalledWith({
      filePath: existingDocument.filePath,
      language: 'markdown',
      mode: 'edit',
      relativePath: existingDocument.relativePath,
      runtimeEnvironmentId: null,
      worktreeId: 'wt-1'
    })
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('opens heading-fragment doc links as editable documents', async () => {
    mocks.listRuntimeMarkdownDocuments.mockResolvedValue([existingDocument])

    await renderHookProbe()

    hookResult().onOpenDocLink('Existing#Install steps')
    await flushPromises()

    expect(mocks.openFile).toHaveBeenCalledWith({
      filePath: existingDocument.filePath,
      language: 'markdown',
      mode: 'edit',
      relativePath: existingDocument.relativePath,
      runtimeEnvironmentId: null,
      worktreeId: 'wt-1'
    })
    expect(mocks.openMarkdownPreview).not.toHaveBeenCalled()
  })

  it('opens block-fragment doc links as editable documents', async () => {
    mocks.listRuntimeMarkdownDocuments.mockResolvedValue([existingDocument])

    await renderHookProbe()

    hookResult().onOpenDocLink('Existing#^block-id')
    await flushPromises()

    expect(mocks.openFile).toHaveBeenCalledWith({
      filePath: existingDocument.filePath,
      language: 'markdown',
      mode: 'edit',
      relativePath: existingDocument.relativePath,
      runtimeEnvironmentId: null,
      worktreeId: 'wt-1'
    })
    expect(mocks.openMarkdownPreview).not.toHaveBeenCalled()
  })

  it('offers to create a missing doc link and opens the created note', async () => {
    const createdDocument: MarkdownDocument = {
      basename: 'New Note.md',
      filePath: '/repo/New Note.md',
      name: 'New Note',
      relativePath: 'New Note.md'
    }
    mocks.createMissingMarkdownDocLinkDocument.mockResolvedValue(createdDocument)

    await renderHookProbe()

    hookResult().onOpenDocLink('New Note')
    await flushPromises()

    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'Note not found',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Create note' }),
        description: 'New Note.md'
      })
    )

    const toastOptions = mocks.toastInfo.mock.calls[0]?.[1] as {
      action?: { onClick?: () => void }
    }
    toastOptions.action?.onClick?.()
    await flushPromises()

    expect(mocks.createMissingMarkdownDocLinkDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'New Note',
        worktreePath: '/repo'
      })
    )
    expect(mocks.openFile).toHaveBeenCalledWith({
      filePath: createdDocument.filePath,
      language: 'markdown',
      mode: 'edit',
      relativePath: createdDocument.relativePath,
      runtimeEnvironmentId: null,
      worktreeId: 'wt-1'
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Note created', {
      description: 'New Note.md'
    })
  })
})
