import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'

const {
  findWorktreeByIdMock,
  getEditorFileOperationContextMock,
  getRuntimeEnvironmentRevisionMock
} = vi.hoisted(() => ({
  findWorktreeByIdMock: vi.fn(),
  getEditorFileOperationContextMock: vi.fn(),
  getRuntimeEnvironmentRevisionMock: vi.fn()
}))

vi.mock('@/store/slices/worktree-helpers', () => ({
  findWorktreeById: findWorktreeByIdMock
}))

vi.mock('@/lib/editor-file-operation-owner', () => ({
  getEditorFileOperationContext: getEditorFileOperationContextMock
}))

vi.mock('@/runtime/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: getRuntimeEnvironmentRevisionMock
}))

import { createEditorPopoutOpenRequest } from './editor-popout-request'

const file = {
  id: '/remote/note.md',
  filePath: '/remote/note.md',
  relativePath: 'note.md',
  worktreeId: 'repo:remote',
  language: 'markdown',
  isDirty: true,
  runtimeEnvironmentId: 'runtime-1',
  externalSshTargetId: 'ssh-1',
  mode: 'edit'
} satisfies OpenFile

describe('createEditorPopoutOpenRequest', () => {
  it('freezes the current SSH owner and disk baseline into the popout request', () => {
    const state = { worktreesByRepo: {} } as AppState
    findWorktreeByIdMock.mockReturnValue({ path: '/remote' })
    getEditorFileOperationContextMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'runtime-1', theme: 'dark' },
      worktreeId: file.worktreeId,
      worktreePath: '/remote',
      connectionId: 'ssh-1',
      expectedExecutionHostId: 'ssh:ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 7
    })
    getRuntimeEnvironmentRevisionMock.mockReturnValue(11)

    expect(
      createEditorPopoutOpenRequest({
        state,
        file,
        content: '# Draft\n',
        savedContent: '# Saved\n',
        viewMode: 'rich',
        showFrontmatter: false
      })
    ).toMatchObject({
      document: {
        runtimeEnvironmentId: 'runtime-1',
        externalSshTargetId: 'ssh-1'
      },
      content: '# Draft\n',
      savedContent: '# Saved\n',
      viewMode: 'rich',
      operationContext: {
        settings: { activeRuntimeEnvironmentId: 'runtime-1' },
        connectionId: 'ssh-1',
        expectedExecutionHostId: 'ssh:ssh-1',
        expectedSshConnectionGeneration: 7,
        expectedEnvironmentPairingRevision: 11,
        expectedExternalSshTargetId: 'ssh-1'
      }
    })
  })

  it('does not detach untitled or read-only files', () => {
    const state = {} as AppState
    expect(
      createEditorPopoutOpenRequest({
        state,
        file: { ...file, isUntitled: true },
        content: '',
        savedContent: '',
        viewMode: 'source',
        showFrontmatter: true
      })
    ).toBeNull()
    expect(
      createEditorPopoutOpenRequest({
        state,
        file: { ...file, readOnly: true },
        content: '',
        savedContent: '',
        viewMode: 'source',
        showFrontmatter: true
      })
    ).toBeNull()
  })
})
