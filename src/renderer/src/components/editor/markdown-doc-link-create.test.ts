import { describe, expect, it, vi } from 'vitest'
import { joinPath } from '@/lib/path'
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
    const worktreePath = joinPath('repo', 'workspace')
    const targetPath = joinPath(worktreePath, 'docs/setup guide.md')
    const pathExists = vi.fn().mockResolvedValue(false)
    const createPath = vi.fn().mockResolvedValue(undefined)
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const context = {
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: 'wt-1',
      worktreePath
    }

    await expect(
      createMissingMarkdownDocLinkDocument({
        actions: { createPath, pathExists, writeFile },
        context,
        target: 'docs/setup guide#Install steps',
        worktreePath
      })
    ).resolves.toEqual({
      filePath: targetPath,
      relativePath: 'docs/setup guide.md',
      basename: 'setup guide.md',
      name: 'setup guide'
    })

    expect(pathExists).toHaveBeenCalledWith(context, targetPath)
    expect(createPath).toHaveBeenCalledWith(context, targetPath, 'file')
    expect(writeFile).toHaveBeenCalledWith(context, targetPath, '# setup guide\n')
  })

  it('opens an existing target without rewriting it', async () => {
    const worktreePath = joinPath('repo', 'workspace')
    const targetPath = joinPath(worktreePath, 'notes/todo.md')
    const pathExists = vi.fn().mockResolvedValue(true)
    const createPath = vi.fn()
    const writeFile = vi.fn()

    await expect(
      createMissingMarkdownDocLinkDocument({
        actions: { createPath, pathExists, writeFile },
        context: {
          settings: { activeRuntimeEnvironmentId: null },
          worktreeId: 'wt-1',
          worktreePath
        },
        target: 'notes/todo.md',
        worktreePath
      })
    ).resolves.toMatchObject({
      filePath: targetPath,
      relativePath: 'notes/todo.md'
    })

    expect(createPath).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('treats create-if-missing races as existing targets', async () => {
    const worktreePath = joinPath('repo', 'workspace')
    const targetPath = joinPath(worktreePath, 'notes/race.md')
    const pathExists = vi.fn().mockResolvedValue(false)
    const createPath = vi.fn().mockRejectedValue(new Error('EEXIST: file already exists'))
    const writeFile = vi.fn()
    const context = {
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: 'wt-1',
      worktreePath
    }

    await expect(
      createMissingMarkdownDocLinkDocument({
        actions: { createPath, pathExists, writeFile },
        context,
        target: 'notes/race',
        worktreePath
      })
    ).resolves.toMatchObject({
      filePath: targetPath,
      relativePath: 'notes/race.md'
    })

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
          worktreePath: joinPath('repo', 'workspace')
        },
        target: '../outside',
        worktreePath: joinPath('repo', 'workspace')
      })
    ).resolves.toBeNull()

    expect(pathExists).not.toHaveBeenCalled()
    expect(createPath).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })
})
