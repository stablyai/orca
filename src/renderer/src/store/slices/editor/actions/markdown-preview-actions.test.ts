import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMarkdownPreviewActions } from './markdown-preview-actions'

const mocks = vi.hoisted(() => ({
  createUntitledMarkdownFileWithTemplateSelection: vi.fn()
}))

vi.mock('@/lib/create-untitled-markdown', () => ({
  createUntitledMarkdownFileWithTemplateSelection:
    mocks.createUntitledMarkdownFileWithTemplateSelection
}))

vi.mock('@/lib/editor-file-operation-owner', () => ({
  assertEditorFileOperationCurrent: vi.fn(),
  captureEditorFileOperationProvenance: vi.fn(() => ({
    generation: {
      route: { executionHostId: 'local', runtimeEnvironmentId: null },
      runtimeEnvironmentGeneration: null
    },
    ownershipProjection: 'explicit'
  })),
  getEditorFileOperationContext: vi.fn(() => ({
    settings: null,
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    expectedExecutionHostId: 'local'
  }))
}))

describe('createMarkdownPreviewActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('hands focus to a newly created markdown editor', async () => {
    const fileInfo = {
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true as const,
      mode: 'edit' as const
    }
    mocks.createUntitledMarkdownFileWithTemplateSelection.mockResolvedValue(fileInfo)
    const openFile = vi.fn()
    const recordFeatureInteraction = vi.fn()
    const state = {
      activeWorktreeId: 'wt-1',
      getKnownWorktreeById: vi.fn(() => ({ id: 'wt-1', path: '/repo' })),
      openFile,
      recordFeatureInteraction
    }
    const actions = createMarkdownPreviewActions(vi.fn() as never, (() => state) as never)

    await actions.openNewMarkdownInActiveWorkspace('group-2')

    expect(openFile).toHaveBeenCalledWith(fileInfo, {
      preview: false,
      targetGroupId: 'group-2',
      focusEditor: true
    })
    expect(recordFeatureInteraction).toHaveBeenCalledWith('markdown-file-created')
  })
})
