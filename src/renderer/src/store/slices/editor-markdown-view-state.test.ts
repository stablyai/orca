import { describe, expect, it, vi } from 'vitest'
import { createEditorStore, ownedEditorFileId } from './editor-slice-test-harness'
import type { AppState } from '../types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

describe('createEditorSlice markdown view state', () => {
  it('updates stale language metadata when reopening an existing file', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/notebooks/example.ipynb',
      relativePath: 'notebooks/example.ipynb',
      worktreeId: 'wt-1',
      language: 'json',
      mode: 'edit'
    })

    store.getState().openFile({
      filePath: '/repo/notebooks/example.ipynb',
      relativePath: 'notebooks/example.ipynb',
      worktreeId: 'wt-1',
      language: 'notebook',
      mode: 'edit'
    })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/repo/notebooks/example.ipynb',
        language: 'notebook'
      })
    ])
  })

  it('drops markdown view mode for a replaced preview tab', () => {
    const store = createEditorStore()

    store.getState().openFile(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'docs/README.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().setMarkdownViewMode('/repo/docs/README.md', 'rich')

    store.getState().openFile(
      {
        filePath: '/repo/docs/guide.md',
        relativePath: 'docs/guide.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )

    expect(store.getState().markdownViewMode).toEqual({})
    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: '/repo/docs/guide.md',
        isPreview: true
      })
    ])
  })

  it('drops markdown visibility for a preview replaced by a diff', () => {
    const store = createEditorStore()

    store.getState().openFile(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'docs/README.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().setMarkdownFrontmatterVisible('/repo/docs/README.md', false)
    store.getState().setMarkdownTableOfContentsVisible('/repo/docs/README.md', true)

    store.getState().openDiff('wt-1', '/repo/docs/guide.md', 'docs/guide.md', 'markdown', false, {
      preview: true
    })

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
    expect(store.getState().markdownTableOfContentsVisible).toEqual({})
  })

  it('keeps markdown visibility when another preview still references a replaced source', () => {
    const store = createEditorStore()

    store.getState().openFile(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'docs/README.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().setMarkdownFrontmatterVisible('/repo/docs/README.md', false)
    store.getState().setMarkdownTableOfContentsVisible('/repo/docs/README.md', true)

    store.getState().openDiff('wt-1', '/repo/docs/guide.md', 'docs/guide.md', 'markdown', false, {
      preview: true
    })

    expect(store.getState().markdownFrontmatterVisible).toEqual({
      '/repo/docs/README.md': false
    })
    expect(store.getState().markdownTableOfContentsVisible).toEqual({
      '/repo/docs/README.md': true
    })
  })
})

describe('createEditorSlice editor view mode', () => {
  it('stores changes mode as an explicit entry keyed by fileId', () => {
    const store = createEditorStore()

    store.getState().setEditorViewMode('/repo/app.ts', 'changes')

    expect(store.getState().editorViewMode).toEqual({ '/repo/app.ts': 'changes' })
  })

  it('deletes the entry when mode resets to edit', () => {
    const store = createEditorStore()
    store.getState().setEditorViewMode('/repo/app.ts', 'changes')

    store.getState().setEditorViewMode('/repo/app.ts', 'edit')

    expect(store.getState().editorViewMode).toEqual({})
  })

  it('is a no-op when resetting a file that was never in changes mode', () => {
    const store = createEditorStore()
    const before = store.getState().editorViewMode

    store.getState().setEditorViewMode('/repo/app.ts', 'edit')

    expect(store.getState().editorViewMode).toBe(before)
  })

  it('drops editor view mode when the file is closed', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/app.ts',
      relativePath: 'app.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorViewMode('/repo/app.ts', 'changes')

    store.getState().closeFile('/repo/app.ts')

    expect(store.getState().editorViewMode).toEqual({})
  })
})

describe('createEditorSlice markdown frontmatter visibility (#4468)', () => {
  it('stores hidden=false as an explicit entry keyed by fileId', () => {
    const store = createEditorStore()

    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    expect(store.getState().markdownFrontmatterVisible).toEqual({ '/repo/notes.md': false })
  })

  it('deletes the entry when visibility resets to visible', () => {
    const store = createEditorStore()
    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', true)

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
  })

  it('is a no-op when showing a file that was never hidden', () => {
    const store = createEditorStore()
    const before = store.getState().markdownFrontmatterVisible

    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', true)

    expect(store.getState().markdownFrontmatterVisible).toBe(before)
  })

  it('drops the visibility flag when the file is closed', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    store.getState().closeFile('/repo/notes.md')

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
  })

  it('keeps the visibility flag while a preview tab still references the source file', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openMarkdownPreview({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    store.getState().closeFile('/repo/notes.md')

    expect(store.getState().markdownFrontmatterVisible).toEqual({ '/repo/notes.md': false })

    store.getState().closeFile('markdown-preview::/repo/notes.md')

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
  })

  it('keeps the visibility flag when replacing an edit preview referenced by a markdown preview', () => {
    const store = createEditorStore()
    store.getState().openFile(
      {
        filePath: '/repo/notes.md',
        relativePath: 'notes.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().openMarkdownPreview(
      {
        filePath: '/repo/notes.md',
        relativePath: 'notes.md',
        worktreeId: 'wt-1',
        language: 'markdown'
      },
      { sourceFileId: '/repo/notes.md' }
    )
    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    store.getState().openFile(
      {
        filePath: '/repo/guide.md',
        relativePath: 'guide.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )

    expect(store.getState().markdownFrontmatterVisible).toEqual({ '/repo/notes.md': false })
  })

  it('drops the visibility flag when all files are closed', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().setMarkdownFrontmatterVisible('/repo/notes.md', false)

    store.getState().closeAllFiles()

    expect(store.getState().markdownFrontmatterVisible).toEqual({})
  })
})

describe('createEditorSlice markdown table of contents visibility', () => {
  it('stores visible=true as an explicit entry keyed by fileId', () => {
    const store = createEditorStore()

    store.getState().setMarkdownTableOfContentsVisible('/repo/notes.md', true)

    expect(store.getState().markdownTableOfContentsVisible).toEqual({ '/repo/notes.md': true })
  })

  it('deletes the entry when visibility resets to hidden', () => {
    const store = createEditorStore()
    store.getState().setMarkdownTableOfContentsVisible('/repo/notes.md', true)

    store.getState().setMarkdownTableOfContentsVisible('/repo/notes.md', false)

    expect(store.getState().markdownTableOfContentsVisible).toEqual({})
  })

  it('drops the visibility flag when replacing a preview tab', () => {
    const store = createEditorStore()
    store.getState().openFile(
      {
        filePath: '/repo/notes.md',
        relativePath: 'notes.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )
    store.getState().setMarkdownTableOfContentsVisible('/repo/notes.md', true)

    store.getState().openFile(
      {
        filePath: '/repo/guide.md',
        relativePath: 'guide.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      },
      { preview: true }
    )

    expect(store.getState().markdownTableOfContentsVisible).toEqual({})
  })

  it('keeps the visibility flag while a preview tab still references the source file', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openMarkdownPreview({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().setMarkdownTableOfContentsVisible('/repo/notes.md', true)

    store.getState().closeFile('/repo/notes.md')

    expect(store.getState().markdownTableOfContentsVisible).toEqual({ '/repo/notes.md': true })

    store.getState().closeFile('markdown-preview::/repo/notes.md')

    expect(store.getState().markdownTableOfContentsVisible).toEqual({})
  })
})

describe('createEditorSlice openMarkdownPreview', () => {
  it('keeps external SSH ownership after the source edit tab closes', () => {
    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/tmp/notes.md',
      relativePath: '/tmp/notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit',
      externalSshTargetId: 'ssh-1'
    })

    store.getState().openMarkdownPreview(
      {
        filePath: '/tmp/notes.md',
        relativePath: '/tmp/notes.md',
        worktreeId: 'wt-1',
        language: 'markdown'
      },
      { sourceFileId: '/tmp/notes.md' }
    )
    store.getState().closeFile('/tmp/notes.md')

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: 'markdown-preview::/tmp/notes.md',
        externalSshTargetId: 'ssh-1'
      })
    ])
  })

  it('opens markdown preview as a separate read-only tab', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: '/repo/docs/README.md',
        mode: 'edit'
      }),
      expect.objectContaining({
        id: 'markdown-preview::/repo/docs/README.md',
        mode: 'markdown-preview',
        markdownPreviewSourceFileId: '/repo/docs/README.md'
      })
    ])
    expect(store.getState().activeFileId).toBe('markdown-preview::/repo/docs/README.md')
  })

  it('retargets an existing preview tab instead of duplicating it', () => {
    const store = createEditorStore()

    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().openMarkdownPreview(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'docs/README.md',
        worktreeId: 'wt-1',
        language: 'markdown'
      },
      { anchor: 'install' }
    )

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: 'markdown-preview::/repo/docs/README.md',
        mode: 'markdown-preview',
        markdownPreviewAnchor: 'install'
      })
    ])
  })

  it('keeps preview-only same-path markdown previews separate by owner', () => {
    const store = createEditorStore()
    const floatingSourceId = ownedEditorFileId(
      '/repo/docs/README.md',
      FLOATING_TERMINAL_WORKTREE_ID,
      null
    )

    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'README.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      runtimeEnvironmentId: null,
      language: 'markdown'
    })

    const previews = store.getState().openFiles.filter((file) => file.mode === 'markdown-preview')
    expect(previews).toEqual([
      expect.objectContaining({
        id: 'markdown-preview::/repo/docs/README.md',
        markdownPreviewSourceFileId: '/repo/docs/README.md',
        worktreeId: 'wt-1'
      }),
      expect.objectContaining({
        id: `markdown-preview::${floatingSourceId}`,
        markdownPreviewSourceFileId: floatingSourceId,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      })
    ])
  })

  it('keeps same-path markdown previews separate by source owner', () => {
    const store = createEditorStore()

    store.getState().openFile({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openFile(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'README.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const floatingFile = store
      .getState()
      .openFiles.find((file) => file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID)
    expect(floatingFile).toBeDefined()

    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })
    store.getState().openMarkdownPreview(
      {
        filePath: '/repo/docs/README.md',
        relativePath: 'README.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown'
      },
      { sourceFileId: floatingFile?.id }
    )

    const previews = store.getState().openFiles.filter((file) => file.mode === 'markdown-preview')
    expect(previews).toHaveLength(2)
    expect(previews.map((file) => file.markdownPreviewSourceFileId)).toEqual([
      '/repo/docs/README.md',
      floatingFile?.id
    ])
  })

  it('uses the resolved active runtime owner when opening markdown previews', () => {
    const store = createEditorStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-active' } as AppState['settings'],
      openFiles: [
        {
          id: '/repo/docs/README.md',
          filePath: '/repo/docs/README.md',
          relativePath: 'docs/README.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          isDirty: false,
          mode: 'edit'
        },
        {
          id: 'editor:wt-1:env-active:readme',
          filePath: '/repo/docs/README.md',
          relativePath: 'docs/README.md',
          worktreeId: 'wt-1',
          runtimeEnvironmentId: 'env-active',
          language: 'markdown',
          isDirty: false,
          mode: 'edit'
        }
      ]
    } as Partial<AppState>)

    store.getState().openMarkdownPreview({
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      worktreeId: 'wt-1',
      language: 'markdown'
    })

    expect(store.getState().openFiles.at(-1)).toMatchObject({
      mode: 'markdown-preview',
      runtimeEnvironmentId: 'env-active',
      markdownPreviewSourceFileId: 'editor:wt-1:env-active:readme'
    })
  })
})
