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
    expect(
      admitEditorPopoutOpenRequest({
        ...validRequest,
        operationContext: {
          ...validRequest.operationContext,
          expectedEnvironmentPairingRevision: -1
        }
      })
    ).toBeNull()
  })

  it('requires a pairing revision that matches the runtime owner', () => {
    const runtimeRequest = {
      ...validRequest,
      document: {
        ...validRequest.document,
        runtimeEnvironmentId: 'runtime-1'
      },
      operationContext: {
        ...validRequest.operationContext,
        settings: { activeRuntimeEnvironmentId: 'runtime-1' },
        expectedEnvironmentPairingRevision: 11
      }
    }

    expect(admitEditorPopoutOpenRequest(runtimeRequest)).toEqual(runtimeRequest)
    expect(
      admitEditorPopoutOpenRequest({
        ...runtimeRequest,
        operationContext: {
          ...runtimeRequest.operationContext,
          expectedEnvironmentPairingRevision: undefined
        }
      })
    ).toBeNull()
    expect(
      admitEditorPopoutOpenRequest({
        ...runtimeRequest,
        operationContext: {
          ...runtimeRequest.operationContext,
          settings: { activeRuntimeEnvironmentId: 'runtime-2' }
        }
      })
    ).toBeNull()
  })
})
