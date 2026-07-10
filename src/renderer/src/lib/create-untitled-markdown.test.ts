import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUntitledMarkdownFile,
  createUntitledMarkdownFileWithTemplateSelection
} from './create-untitled-markdown'
import { subscribeMarkdownTemplatePicker } from './markdown-template-picker-request'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

describe('createUntitledMarkdownFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries with the next untitled name when createFile loses the EEXIST race', async () => {
    const pathExists = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    const stat = vi.fn(async (args: { filePath: string }) => {
      if (args.filePath.endsWith('untitled.md')) {
        return { size: 0, isDirectory: false, mtime: 1 }
      }
      throw new Error('ENOENT: no such file')
    })
    const createFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('EEXIST: file already exists'))
      .mockResolvedValueOnce(undefined)

    vi.stubGlobal('window', {
      api: {
        shell: { pathExists: vi.fn() },
        fs: { createFile, pathExists, stat }
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
    expect(pathExists).toHaveBeenCalledTimes(3)
  })

  it('throws a descriptive error when untitled names are exhausted', async () => {
    const pathExists = vi.fn(async () => true)
    const stat = vi.fn().mockResolvedValue({ size: 0, isDirectory: false, mtime: 1 })
    const createFile = vi.fn()

    vi.stubGlobal('window', {
      api: {
        shell: { pathExists: vi.fn() },
        fs: { createFile, pathExists, stat }
      }
    })

    await expect(createUntitledMarkdownFile('/repo', 'wt-1')).rejects.toThrow(
      'Unable to create untitled markdown file after 100 attempts.'
    )

    expect(createFile).not.toHaveBeenCalled()
    expect(pathExists).toHaveBeenCalledTimes(100)
  })

  it('passes connectionId to pathExists and createFile for SSH worktrees', async () => {
    const pathExists = vi.fn(async () => false)
    const stat = vi.fn().mockRejectedValue(new Error('ENOENT: no such file'))
    const createFile = vi.fn().mockResolvedValueOnce(undefined)

    vi.stubGlobal('window', {
      api: {
        shell: { pathExists: vi.fn() },
        fs: { createFile, pathExists, stat }
      }
    })

    await expect(createUntitledMarkdownFile('/repo', 'wt-1', 'conn-1')).resolves.toMatchObject({
      filePath: '/repo/untitled.md'
    })

    // Why: shell.pathExists is main-process local-only; SSH worktrees must
    // probe through the same filesystem API that receives the connectionId.
    expect(pathExists).toHaveBeenCalledWith({
      filePath: '/repo/untitled.md',
      connectionId: 'conn-1'
    })
    expect(stat).not.toHaveBeenCalled()
    expect(createFile).toHaveBeenCalledWith({
      filePath: '/repo/untitled.md',
      connectionId: 'conn-1'
    })
  })

  it('writes selected template content with placeholders after creating the untitled file', async () => {
    const stat = vi.fn().mockRejectedValue(new Error('ENOENT: no such file'))
    const createFile = vi.fn().mockResolvedValueOnce(undefined)
    const readFile = vi.fn().mockResolvedValueOnce({
      content: '# {{ title }}\n{{date}}\n{{filename}}\n',
      isBinary: false
    })
    const writeFile = vi.fn().mockResolvedValueOnce(undefined)

    vi.stubGlobal('window', {
      api: {
        shell: { pathExists: vi.fn() },
        fs: { createFile, pathExists: vi.fn().mockResolvedValue(false), readFile, stat, writeFile }
      }
    })

    await expect(
      createUntitledMarkdownFile('/repo', 'wt-1', undefined, undefined, {
        now: new Date(2026, 4, 29, 7, 5),
        template: {
          id: '.orca/templates/daily.md',
          name: 'Daily',
          filePath: '/repo/.orca/templates/daily.md',
          relativePath: '.orca/templates/daily.md',
          templateRelativePath: 'daily.md',
          basename: 'daily.md'
        }
      })
    ).resolves.toMatchObject({
      filePath: '/repo/untitled.md',
      relativePath: 'untitled.md',
      deleteUntouchedOnClose: false
    })

    expect(readFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/.orca/templates/daily.md' })
    )
    expect(createFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/untitled.md' })
    )
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/untitled.md',
        content: '# Untitled\n2026-05-29\nuntitled.md\n'
      })
    )
  })

  it('discovers templates before creating a new markdown file and applies the selected template', async () => {
    const readDir = vi.fn().mockResolvedValueOnce([
      { name: 'daily.md', isDirectory: false, isSymlink: false },
      { name: 'draft.txt', isDirectory: false, isSymlink: false }
    ])
    const stat = vi.fn().mockRejectedValue(new Error('ENOENT: no such file'))
    const createFile = vi.fn().mockResolvedValueOnce(undefined)
    const readFile = vi.fn().mockResolvedValueOnce({
      content: '# {{title}}\n',
      isBinary: false
    })
    const writeFile = vi.fn().mockResolvedValueOnce(undefined)
    const pathExists = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath.endsWith('/.orca/templates')
    )
    const unsubscribe = subscribeMarkdownTemplatePicker((request) => {
      const template = request.templates[0]
      if (!template) {
        throw new Error('Expected a discovered template')
      }
      request.resolve({ type: 'template', template })
    })

    vi.stubGlobal('window', {
      api: {
        shell: { pathExists: vi.fn() },
        fs: {
          createFile,
          pathExists,
          readDir,
          readFile,
          stat,
          writeFile
        }
      }
    })

    try {
      await expect(
        createUntitledMarkdownFileWithTemplateSelection('/repo', 'wt-1')
      ).resolves.toMatchObject({
        filePath: '/repo/untitled.md',
        relativePath: 'untitled.md',
        deleteUntouchedOnClose: false
      })
    } finally {
      unsubscribe()
    }

    expect(readDir).toHaveBeenCalledWith(
      expect.objectContaining({ dirPath: '/repo/.orca/templates' })
    )
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/untitled.md', content: '# Untitled\n' })
    )
  })

  it('creates untitled files through the selected runtime environment', async () => {
    clearRuntimeCompatibilityCacheForTests()
    const stat = vi.fn()
    const createFile = vi.fn()
    const runtimeEnvironmentCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'rpc-1',
        ok: false,
        error: { message: 'ENOENT: no such file' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-2',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
    const runtimeEnvironmentTransportCall = vi.fn((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })

    vi.stubGlobal('window', {
      api: {
        shell: { pathExists: vi.fn() },
        fs: { createFile, stat },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
      }
    })

    await expect(
      createUntitledMarkdownFile('/remote/repo', 'wt-1', undefined, {
        activeRuntimeEnvironmentId: 'env-1'
      })
    ).resolves.toMatchObject({
      filePath: '/remote/repo/untitled.md',
      relativePath: 'untitled.md'
    })

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'files.stat',
      params: { worktree: 'id:wt-1', relativePath: 'untitled.md' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.createFile',
      params: { worktree: 'id:wt-1', relativePath: 'untitled.md' },
      timeoutMs: 15_000
    })
    expect(stat).not.toHaveBeenCalled()
    expect(createFile).not.toHaveBeenCalled()
  })
})
