import { describe, expect, it, vi } from 'vitest'
import {
  createMissingMarkdownDocLinkDocument,
  getInitialMarkdownDocLinkDocumentContent
} from './markdown-doc-link-create'

describe('getInitialMarkdownDocLinkDocumentContent', () => {
  it('creates a heading from the note title', () => {
    expect(getInitialMarkdownDocLinkDocumentContent('Project Notes')).toBe('# Project Notes\n')
  })
})

describe('createMissingMarkdownDocLinkDocument', () => {
  it('creates a missing markdown target and returns its document record', async () => {
    const pathExists = vi.fn().mockResolvedValue(false)
    const createPath = vi.fn().mockResolvedValue(undefined)
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const context = {
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    }

    await expect(
      createMissingMarkdownDocLinkDocument({
        actions: { createPath, pathExists, writeFile },
        context,
        target: 'docs/setup guide#Install steps',
        worktreePath: '/repo'
      })
    ).resolves.toEqual({
      filePath: '/repo/docs/setup guide.md',
      relativePath: 'docs/setup guide.md',
      basename: 'setup guide.md',
      name: 'setup guide'
    })

    expect(pathExists).toHaveBeenCalledWith(context, '/repo/docs/setup guide.md')
    expect(createPath).toHaveBeenCalledWith(context, '/repo/docs/setup guide.md', 'file')
    expect(writeFile).toHaveBeenCalledWith(context, '/repo/docs/setup guide.md', '# setup guide\n')
  })

  it('opens an existing target without rewriting it', async () => {
    const pathExists = vi.fn().mockResolvedValue(true)
    const createPath = vi.fn()
    const writeFile = vi.fn()

    await expect(
      createMissingMarkdownDocLinkDocument({
        actions: { createPath, pathExists, writeFile },
        context: {
          settings: { activeRuntimeEnvironmentId: null },
          worktreeId: 'wt-1',
          worktreePath: '/repo'
        },
        target: 'notes/todo.md',
        worktreePath: '/repo'
      })
    ).resolves.toMatchObject({
      filePath: '/repo/notes/todo.md',
      relativePath: 'notes/todo.md'
    })

    expect(createPath).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('rejects unsafe targets', async () => {
    const pathExists = vi.fn()
    const createPath = vi.fn()
    const writeFile = vi.fn()

    await expect(
      createMissingMarkdownDocLinkDocument({
        actions: { createPath, pathExists, writeFile },
        context: {
          settings: { activeRuntimeEnvironmentId: null },
          worktreeId: 'wt-1',
          worktreePath: '/repo'
        },
        target: '../outside',
        worktreePath: '/repo'
      })
    ).resolves.toBeNull()

    expect(pathExists).not.toHaveBeenCalled()
    expect(createPath).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })
})
