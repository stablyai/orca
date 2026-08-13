import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { EditorPopoutOpenRequest } from '../../../../shared/editor-popout'

const { createRequestMock, toastErrorMock } = vi.hoisted(() => ({
  createRequestMock: vi.fn(),
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./editor-popout-request', () => ({
  createEditorPopoutOpenRequest: createRequestMock
}))

import { createEditorPopoutAction } from './editor-popout-action'

const file: OpenFile = {
  id: '/workspace/note.md',
  filePath: '/workspace/note.md',
  relativePath: 'note.md',
  worktreeId: 'repo:main',
  language: 'markdown',
  isDirty: false,
  mode: 'edit'
}

const request = {
  document: {
    id: file.id,
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    language: 'markdown'
  },
  content: '# Draft\n',
  savedContent: '# Saved\n',
  viewMode: 'source',
  showFrontmatter: true,
  operationContext: {
    settings: { activeRuntimeEnvironmentId: null },
    worktreeId: 'repo:main',
    worktreePath: '/workspace',
    expectedExecutionHostId: 'local'
  }
} satisfies EditorPopoutOpenRequest

describe('createEditorPopoutAction', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('closes the original editor only after the detached window opens', async () => {
    const closeFile = vi.fn()
    const open = vi.fn().mockResolvedValue({ created: true })
    createRequestMock.mockReturnValue(request)
    vi.stubGlobal('window', { api: { editorPopout: { open } } })
    const action = createEditorPopoutAction({
      getState: () => ({ closeFile }) as unknown as AppState,
      file,
      fileContent: { content: '# Saved\n', isBinary: false },
      content: '# Draft\n',
      viewMode: 'source',
      showFrontmatter: true
    })

    action?.()
    await vi.waitFor(() => expect(closeFile).toHaveBeenCalledWith(file.id))
    expect(open).toHaveBeenCalledWith(request)
  })

  it('keeps a new draft open when an existing detached window is only focused', async () => {
    const closeFile = vi.fn()
    const open = vi.fn().mockResolvedValue({ created: false })
    createRequestMock.mockReturnValue(request)
    vi.stubGlobal('window', { api: { editorPopout: { open } } })
    const action = createEditorPopoutAction({
      getState: () => ({ closeFile }) as unknown as AppState,
      file,
      fileContent: { content: '# Saved\n', isBinary: false },
      content: '# New draft\n',
      viewMode: 'source',
      showFrontmatter: true
    })

    action?.()
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    expect(closeFile).not.toHaveBeenCalled()
  })

  it('keeps the original editor when the detached window fails to open', async () => {
    const closeFile = vi.fn()
    const open = vi.fn().mockRejectedValue(new Error('open failed'))
    createRequestMock.mockReturnValue(request)
    vi.stubGlobal('window', { api: { editorPopout: { open } } })
    const action = createEditorPopoutAction({
      getState: () => ({ closeFile }) as unknown as AppState,
      file,
      fileContent: { content: '# Saved\n', isBinary: false },
      content: '# Draft\n',
      viewMode: 'source',
      showFrontmatter: true
    })

    action?.()
    await vi.waitFor(() => expect(toastErrorMock).toHaveBeenCalledOnce())
    expect(closeFile).not.toHaveBeenCalled()
  })
})
