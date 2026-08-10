import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorPopoutOpenRequest } from '../../../../shared/editor-popout'

const { readRuntimeFileContentMock, writeRuntimeFileMock } = vi.hoisted(() => ({
  readRuntimeFileContentMock: vi.fn(),
  writeRuntimeFileMock: vi.fn()
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFileContent: readRuntimeFileContentMock,
  writeRuntimeFile: writeRuntimeFileMock
}))

import { saveEditorPopoutDocument } from './editor-popout-save'

const request = {
  document: {
    id: '/workspace/note.md',
    filePath: '/workspace/note.md',
    relativePath: 'note.md',
    worktreeId: 'repo:main',
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

describe('saveEditorPopoutDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readRuntimeFileContentMock.mockResolvedValue({
      content: request.savedContent,
      isBinary: false
    })
    writeRuntimeFileMock.mockResolvedValue(undefined)
  })

  it('writes through the frozen runtime owner when the disk baseline matches', async () => {
    await expect(
      saveEditorPopoutDocument(request, '# Updated\n', request.savedContent)
    ).resolves.toEqual({ ok: true })

    expect(writeRuntimeFileMock).toHaveBeenCalledWith(
      request.operationContext,
      request.document.filePath,
      '# Updated\n'
    )
  })

  it('refuses to overwrite a file changed outside the detached editor', async () => {
    readRuntimeFileContentMock.mockResolvedValue({
      content: '# Agent update\n',
      isBinary: false
    })

    await expect(
      saveEditorPopoutDocument(request, '# User update\n', request.savedContent)
    ).resolves.toEqual({ ok: false, reason: 'external-change' })
    expect(writeRuntimeFileMock).not.toHaveBeenCalled()
  })
})
