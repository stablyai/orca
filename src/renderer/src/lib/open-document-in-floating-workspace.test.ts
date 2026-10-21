import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { MarkdownDocument } from '../../../shared/filesystem-entry-types'
import type { EditorFilesSlice } from '@/store/slices/editor/types/editor-files-slice'
import { openDocumentInFloatingWorkspace } from './open-document-in-floating-workspace'

function openFileMock(): ReturnType<typeof vi.fn<EditorFilesSlice['openFile']>> {
  return vi.fn<EditorFilesSlice['openFile']>(() => 'file-1')
}

function markdownDocument(overrides: Partial<MarkdownDocument> = {}): MarkdownDocument {
  return {
    filePath: '/Users/me/notes/README.md',
    relativePath: 'README.md',
    basename: 'README.md',
    name: 'README',
    ...overrides
  }
}

describe('openDocumentInFloatingWorkspace', () => {
  it('opens the document as a permanent floating-workspace edit tab', () => {
    const openFile = openFileMock()

    const fileId = openDocumentInFloatingWorkspace(openFile, markdownDocument())

    expect(fileId).toBe('file-1')
    expect(openFile).toHaveBeenCalledTimes(1)
    expect(openFile.mock.calls[0][0]).toEqual({
      filePath: '/Users/me/notes/README.md',
      relativePath: 'README.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      language: 'markdown',
      mode: 'edit',
      runtimeEnvironmentId: null
    })
    expect(openFile.mock.calls[0][1]).toEqual({
      preview: false,
      targetGroupId: undefined,
      suppressActiveRuntimeFallback: true
    })
  })

  it('pins the open to this machine instead of the active runtime', () => {
    const openFile = openFileMock()

    openDocumentInFloatingWorkspace(openFile, markdownDocument())

    // Why: the caller already resolved an absolute local path, so a null runtime plus the
    // fallback suppression is what keeps the read off a remote SSH host the user is focused on.
    // Dropping either one silently reads the file on the wrong machine.
    expect(openFile.mock.calls[0][0].runtimeEnvironmentId).toBeNull()
    expect(openFile.mock.calls[0][1]?.suppressActiveRuntimeFallback).toBe(true)
  })

  it.each(['mdx', 'csv', 'tsv'])(
    'derives the language for %s from the relative path',
    (extension) => {
      const openFile = openFileMock()

      openDocumentInFloatingWorkspace(
        openFile,
        markdownDocument({
          filePath: `/Users/me/notes/plan.${extension}`,
          relativePath: `plan.${extension}`,
          basename: `plan.${extension}`,
          name: 'plan'
        })
      )

      expect(openFile.mock.calls[0][0].language).toBe(extension === 'mdx' ? 'markdown' : extension)
      expect(openFile.mock.calls[0][0].runtimeEnvironmentId).toBeNull()
      expect(openFile.mock.calls[0][1]?.suppressActiveRuntimeFallback).toBe(true)
    }
  )

  it('forwards a requested target group', () => {
    const openFile = openFileMock()

    openDocumentInFloatingWorkspace(openFile, markdownDocument(), {
      targetGroupId: 'group-2'
    })

    expect(openFile.mock.calls[0][1]?.targetGroupId).toBe('group-2')
  })
})
