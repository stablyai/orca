import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { MarkdownDocument } from '../../../shared/filesystem-entry-types'
import type { EditorFilesSlice } from '@/store/slices/editor/types/editor-files-slice'
import { openMarkdownDocumentInFloatingWorkspace } from './open-markdown-in-floating-workspace'

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

describe('openMarkdownDocumentInFloatingWorkspace', () => {
  it('opens the document as a permanent floating-workspace edit tab', () => {
    const openFile = openFileMock()

    const fileId = openMarkdownDocumentInFloatingWorkspace(openFile, markdownDocument())

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

    openMarkdownDocumentInFloatingWorkspace(openFile, markdownDocument())

    // Why: the caller already resolved an absolute local path, so a null runtime plus the
    // fallback suppression is what keeps the read off a remote SSH host the user is focused on.
    // Dropping either one silently reads the file on the wrong machine.
    expect(openFile.mock.calls[0][0].runtimeEnvironmentId).toBeNull()
    expect(openFile.mock.calls[0][1]?.suppressActiveRuntimeFallback).toBe(true)
  })

  it('derives the language from the relative path', () => {
    const openFile = openFileMock()

    openMarkdownDocumentInFloatingWorkspace(
      openFile,
      markdownDocument({
        filePath: '/Users/me/notes/plan.mdx',
        relativePath: 'plan.mdx',
        basename: 'plan.mdx',
        name: 'plan'
      })
    )

    expect(openFile.mock.calls[0][0].language).toBe('markdown')
  })

  it('forwards a requested target group', () => {
    const openFile = openFileMock()

    openMarkdownDocumentInFloatingWorkspace(openFile, markdownDocument(), {
      targetGroupId: 'group-2'
    })

    expect(openFile.mock.calls[0][1]?.targetGroupId).toBe('group-2')
  })
})
