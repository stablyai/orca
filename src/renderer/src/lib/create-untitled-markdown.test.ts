import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUntitledMarkdownFile } from './create-untitled-markdown'
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
    const pathExists = vi.fn()
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
        shell: { pathExists },
        fs: { createFile, stat }
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
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('throws a descriptive error when untitled names are exhausted', async () => {
    const pathExists = vi.fn(async () => true)
    const stat = vi.fn().mockResolvedValue({ size: 0, isDirectory: false, mtime: 1 })
    const createFile = vi.fn()

    vi.stubGlobal('window', {
      api: {
        shell: { pathExists },
        fs: { createFile, stat }
      }
    })

    await expect(createUntitledMarkdownFile('/repo', 'wt-1')).rejects.toThrow(
      'Unable to create untitled markdown file after 100 attempts.'
    )

    expect(createFile).not.toHaveBeenCalled()
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('passes connectionId to stat and createFile for SSH worktrees', async () => {
    const pathExists = vi.fn(async () => false)
    const stat = vi.fn().mockRejectedValue(new Error('ENOENT: no such file'))
    const createFile = vi.fn().mockResolvedValueOnce(undefined)

    vi.stubGlobal('window', {
      api: {
        shell: { pathExists },
        fs: { createFile, stat }
      }
    })

    await expect(createUntitledMarkdownFile('/repo', 'wt-1', 'conn-1')).resolves.toMatchObject({
      filePath: '/repo/untitled.md'
    })

    // Why: shell.pathExists is main-process local-only; SSH worktrees must
    // probe through the same filesystem API that receives the connectionId.
    expect(pathExists).not.toHaveBeenCalled()
    expect(stat).toHaveBeenCalledWith({
      filePath: '/repo/untitled.md',
      connectionId: 'conn-1'
    })
    expect(createFile).toHaveBeenCalledWith({
      filePath: '/repo/untitled.md',
      connectionId: 'conn-1'
    })
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
      params: { worktree: 'wt-1', relativePath: 'untitled.md' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.createFile',
      params: { worktree: 'wt-1', relativePath: 'untitled.md' },
      timeoutMs: 15_000
    })
    expect(stat).not.toHaveBeenCalled()
    expect(createFile).not.toHaveBeenCalled()
  })
})
