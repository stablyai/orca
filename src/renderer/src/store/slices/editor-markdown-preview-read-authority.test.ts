import { describe, expect, it, vi } from 'vitest'
import { createEditorStore } from './editor-slice-test-harness'
import type { OpenFile } from './editor'
import { isClientLocalReadOnlyTab } from '@/lib/local-file-access'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: vi.fn()
}))

const PREVIEW_INPUT = {
  filePath: '/tmp/task/brief.md',
  relativePath: '/tmp/task/brief.md',
  worktreeId: 'wt-1',
  runtimeEnvironmentId: 'env-1',
  language: 'markdown'
}

function grantedSourceTab(grantId: string): OpenFile {
  return {
    id: 'brief-source',
    ...PREVIEW_INPUT,
    isDirty: false,
    readOnly: true,
    terminalArtifactGrantId: grantId,
    mode: 'edit'
  }
}

describe('markdown preview read authority (#31034)', () => {
  it('reads a terminal-opened host file with its source tab grant', () => {
    const store = createEditorStore()
    store.setState({ openFiles: [grantedSourceTab('grant-1')] })

    store.getState().openMarkdownPreview(PREVIEW_INPUT, { sourceFileId: 'brief-source' })

    expect(store.getState().openFiles.at(-1)).toMatchObject({
      id: 'markdown-preview::brief-source',
      mode: 'markdown-preview',
      runtimeEnvironmentId: 'env-1',
      terminalArtifactGrantId: 'grant-1',
      readOnly: true
    })
  })

  it('moves an open preview to the source tab fresh grant', () => {
    const store = createEditorStore()
    store.setState({ openFiles: [grantedSourceTab('grant-1')] })
    store.getState().openMarkdownPreview(PREVIEW_INPUT, { sourceFileId: 'brief-source' })

    store.setState({
      openFiles: [
        grantedSourceTab('grant-2'),
        ...store.getState().openFiles.filter((file) => file.id !== 'brief-source')
      ]
    })
    store.getState().openMarkdownPreview(PREVIEW_INPUT, { sourceFileId: 'brief-source' })

    const previews = store
      .getState()
      .openFiles.filter((file) => file.id === 'markdown-preview::brief-source')
    expect(previews).toEqual([
      expect.objectContaining({ terminalArtifactGrantId: 'grant-2', fileContentReloadNonce: 1 })
    ])
  })

  it('keeps a client-local file preview on this computer in an SSH workspace', () => {
    const store = createEditorStore()
    store.setState({
      openFiles: [
        {
          id: 'local-notes',
          filePath: '/Users/me/notes.md',
          relativePath: '/Users/me/notes.md',
          worktreeId: 'wt-ssh',
          runtimeEnvironmentId: null,
          language: 'markdown',
          isDirty: false,
          readOnly: true,
          mode: 'edit'
        }
      ]
    })

    store.getState().openMarkdownPreview(
      {
        filePath: '/Users/me/notes.md',
        relativePath: '/Users/me/notes.md',
        worktreeId: 'wt-ssh',
        runtimeEnvironmentId: null,
        language: 'markdown'
      },
      { sourceFileId: 'local-notes' }
    )

    expect(store.getState().openFiles.at(-1)).toMatchObject({
      mode: 'markdown-preview',
      runtimeEnvironmentId: null,
      readOnly: true
    })
    const preview = store.getState().openFiles.at(-1)
    expect(preview?.terminalArtifactGrantId).toBeUndefined()
    expect(preview && isClientLocalReadOnlyTab(preview)).toBe(true)
  })

  it('keeps the grant when a preview is retargeted after its source tab closed', () => {
    const store = createEditorStore()
    store.setState({ openFiles: [grantedSourceTab('grant-1')] })
    store.getState().openMarkdownPreview(PREVIEW_INPUT, { sourceFileId: 'brief-source' })
    store.setState({
      openFiles: store.getState().openFiles.filter((file) => file.id !== 'brief-source')
    })

    store
      .getState()
      .openMarkdownPreview(PREVIEW_INPUT, { sourceFileId: 'brief-source', anchor: 'plan' })

    const [retargeted] = store.getState().openFiles
    expect(retargeted?.fileContentReloadNonce).toBeUndefined()
    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: 'markdown-preview::brief-source',
        markdownPreviewAnchor: 'plan',
        terminalArtifactGrantId: 'grant-1',
        readOnly: true
      })
    ])
  })
})
