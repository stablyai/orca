import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUntitledMarkdownFile } from './create-untitled-markdown'

describe('createUntitledMarkdownFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries with the next untitled name when createFile loses the EEXIST race', async () => {
    const pathExists = vi.fn(async (filePath: string) => filePath.endsWith('untitled.md'))
    const createFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('EEXIST: file already exists'))
      .mockResolvedValueOnce(undefined)

    vi.stubGlobal('window', {
      api: {
        shell: { pathExists },
        fs: { createFile }
      }
    })

    await expect(createUntitledMarkdownFile('/repo', 'wt-1')).resolves.toEqual({
      filePath: '/repo/untitled-3.md',
      relativePath: 'untitled-3.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    expect(createFile).toHaveBeenNthCalledWith(1, { filePath: '/repo/untitled-2.md' })
    expect(createFile).toHaveBeenNthCalledWith(2, { filePath: '/repo/untitled-3.md' })
  })

  it('throws a descriptive error when untitled names are exhausted', async () => {
    const pathExists = vi.fn(async () => true)
    const createFile = vi.fn()

    vi.stubGlobal('window', {
      api: {
        shell: { pathExists },
        fs: { createFile }
      }
    })

    await expect(createUntitledMarkdownFile('/repo', 'wt-1')).rejects.toThrow(
      'Unable to create untitled markdown file after 100 attempts.'
    )

    expect(createFile).not.toHaveBeenCalled()
  })

  it('passes connectionId to createFile and skips the local pathExists probe for SSH worktrees', async () => {
    const pathExists = vi.fn(async () => false)
    const createFile = vi.fn().mockResolvedValueOnce(undefined)

    vi.stubGlobal('window', {
      api: {
        shell: { pathExists },
        fs: { createFile }
      }
    })

    await expect(createUntitledMarkdownFile('/repo', 'wt-1', 'conn-1')).resolves.toMatchObject({
      filePath: '/repo/untitled.md'
    })

    // Why: shell.pathExists is main-process local-only; probing it on SSH
    // worktrees always reports "not found" or succeeds against the wrong
    // filesystem, so the probe must be skipped when a connectionId is set.
    expect(pathExists).not.toHaveBeenCalled()
    expect(createFile).toHaveBeenCalledWith({
      filePath: '/repo/untitled.md',
      connectionId: 'conn-1'
    })
  })
})
