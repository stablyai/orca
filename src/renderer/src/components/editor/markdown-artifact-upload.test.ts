import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import {
  createCurrentMarkdownArtifactRequest,
  createMarkdownArtifactRequest,
  markdownArtifactSourceKey
} from './markdown-artifact-upload'

const mocks = vi.hoisted(() => ({
  drafts: {} as Record<string, string>,
  flush: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ editorDrafts: mocks.drafts }) }
}))
vi.mock('./editor-pending-flush', () => ({
  flushPendingEditorChange: mocks.flush
}))

beforeEach(() => {
  mocks.drafts = {}
  mocks.flush.mockReset()
})

function openFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/notes.md',
    filePath: '/repo/notes.md',
    relativePath: 'notes.md',
    worktreeId: 'worktree-1',
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

describe('Markdown artifact upload', () => {
  it('uses the ordinary file path for local and folder workspaces', () => {
    expect(markdownArtifactSourceKey(openFile())).toBe('/repo/notes.md')
    expect(createMarkdownArtifactRequest(openFile(), '# Draft')).toEqual({
      sourceKey: '/repo/notes.md',
      content: '# Draft',
      contentType: 'text/markdown',
      fileName: 'notes.md'
    })
  })

  it('isolates source identity by runtime owner', () => {
    const file = openFile({
      runtimeEnvironmentId: 'server-1',
      operationProvenance: {
        ownershipProjection: 'explicit',
        generation: {
          route: {
            runtimeEnvironmentId: 'server-1',
            executionHostId: 'ssh:build-box'
          },
          runtimeConnectionGeneration: 1,
          runtimePairingRevision: 1,
          runtimeSshGeneration: 1,
          nestedSshGeneration: 1,
          directSshGeneration: null
        }
      }
    })
    expect(JSON.parse(markdownArtifactSourceKey(file))).toEqual([
      'ssh',
      'build-box',
      '/repo/notes.md'
    ])
  })

  it('matches the SSH CLI source identity for external files', () => {
    expect(
      JSON.parse(markdownArtifactSourceKey(openFile({ externalSshTargetId: 'build-box' })))
    ).toEqual(['ssh', 'build-box', '/repo/notes.md'])
  })

  it('flushes and reads the latest unsaved editor buffer', () => {
    mocks.flush.mockImplementation((fileId: string) => {
      mocks.drafts[fileId] = '# Latest edit'
    })

    expect(
      createCurrentMarkdownArtifactRequest(openFile(), '/repo/notes.md', '# Stale content').content
    ).toBe('# Latest edit')
    expect(mocks.flush).toHaveBeenCalledWith('/repo/notes.md')
  })
})
