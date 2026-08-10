import { describe, expect, it } from 'vitest'
import { admitEditorPopoutOpenRequest, type EditorPopoutOpenRequest } from './editor-popout'

const validRequest = {
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

describe('admitEditorPopoutOpenRequest', () => {
  it('accepts a bounded Markdown editor request', () => {
    expect(admitEditorPopoutOpenRequest(validRequest)).toEqual(validRequest)
  })

  it('rejects requests whose operation owner does not match the document', () => {
    expect(
      admitEditorPopoutOpenRequest({
        ...validRequest,
        operationContext: {
          ...validRequest.operationContext,
          worktreeId: 'repo:other'
        }
      })
    ).toBeNull()
  })

  it('rejects non-Markdown documents and malformed execution hosts', () => {
    expect(
      admitEditorPopoutOpenRequest({
        ...validRequest,
        document: { ...validRequest.document, language: 'typescript' }
      })
    ).toBeNull()
    expect(
      admitEditorPopoutOpenRequest({
        ...validRequest,
        operationContext: {
          ...validRequest.operationContext,
          expectedExecutionHostId: 'runtime:remote'
        }
      })
    ).toBeNull()
  })
})
