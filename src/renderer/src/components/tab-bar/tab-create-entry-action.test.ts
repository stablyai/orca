import { describe, expect, it, vi } from 'vitest'
import { openTabEntryWithOperations, type TabEntryOperations } from './tab-create-entry-action'

const readyFiles = (files: string[]) => ({ files, loading: false, loadError: null })

describe('openTabEntryWithOperations', () => {
  function makeOperations(overrides: Partial<TabEntryOperations> = {}): TabEntryOperations {
    return {
      createBrowserTab: vi.fn() as TabEntryOperations['createBrowserTab'],
      createRuntimePath: vi.fn().mockResolvedValue(undefined),
      createWebRuntimeSessionBrowserTab: vi.fn().mockResolvedValue(true),
      isWebRuntimeSessionActive: vi.fn().mockReturnValue(false),
      openFile: vi.fn(),
      statRuntimePath: vi.fn().mockResolvedValue({ size: 1, isDirectory: false, mtime: 1 }),
      ...overrides
    }
  }

  const baseArgs = {
    fileList: readyFiles(['src/index.ts']),
    worktreeId: 'wt-1',
    groupId: 'group-1',
    worktreePath: '/repo',
    runtimeContext: {
      settings: null,
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    },
    activeRuntimeEnvironmentId: null
  }

  it('stats existing files before opening and rejects directories', async () => {
    const operations = makeOperations({
      statRuntimePath: vi.fn().mockResolvedValue({ size: 0, isDirectory: true, mtime: 1 })
    })

    await expect(
      openTabEntryWithOperations({ ...baseArgs, query: 'src/index.ts', operations })
    ).rejects.toThrow('Cannot open a directory')
    expect(operations.openFile).not.toHaveBeenCalled()
  })

  it('creates new files and opens them in the target group', async () => {
    const operations = makeOperations()

    await openTabEntryWithOperations({ ...baseArgs, query: 'docs/new.md', operations })

    expect(operations.createRuntimePath).toHaveBeenCalledWith(
      baseArgs.runtimeContext,
      '/repo/docs',
      'directory'
    )
    expect(operations.createRuntimePath).toHaveBeenCalledWith(
      baseArgs.runtimeContext,
      '/repo/docs/new.md',
      'file'
    )
    expect(operations.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/docs/new.md',
        relativePath: 'docs/new.md',
        worktreeId: 'wt-1'
      }),
      { preview: false, targetGroupId: 'group-1' }
    )
  })

  it('uses the selected action instead of reclassifying the query', async () => {
    const operations = makeOperations()

    await openTabEntryWithOperations({
      ...baseArgs,
      classification: {
        kind: 'existing-file',
        matchKind: 'fuzzy',
        relativePath: 'README.md'
      },
      fileList: readyFiles(['README.md']),
      query: 'read.md',
      operations
    })

    expect(operations.createRuntimePath).not.toHaveBeenCalled()
    expect(operations.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'README.md' }),
      { preview: false, targetGroupId: 'group-1' }
    )
  })

  it('creates missing parent directories one level at a time before nested new files', async () => {
    const operations = makeOperations()

    await openTabEntryWithOperations({
      ...baseArgs,
      query: '.tmp/direct-entry-validation/created.md',
      operations
    })

    expect(operations.createRuntimePath).toHaveBeenNthCalledWith(
      1,
      baseArgs.runtimeContext,
      '/repo/.tmp',
      'directory'
    )
    expect(operations.createRuntimePath).toHaveBeenNthCalledWith(
      2,
      baseArgs.runtimeContext,
      '/repo/.tmp/direct-entry-validation',
      'directory'
    )
    expect(operations.createRuntimePath).toHaveBeenNthCalledWith(
      3,
      baseArgs.runtimeContext,
      '/repo/.tmp/direct-entry-validation/created.md',
      'file'
    )
    expect(operations.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/.tmp/direct-entry-validation/created.md',
        relativePath: '.tmp/direct-entry-validation/created.md'
      }),
      { preview: false, targetGroupId: 'group-1' }
    )
  })

  it('continues when a parent directory already exists', async () => {
    const operations = makeOperations({
      createRuntimePath: vi
        .fn()
        .mockRejectedValueOnce(new Error("A file or folder named 'docs' already exists"))
        .mockResolvedValue(undefined),
      statRuntimePath: vi
        .fn()
        .mockResolvedValueOnce({ size: 1, isDirectory: true, mtime: 1 })
        .mockResolvedValue({ size: 1, isDirectory: false, mtime: 1 })
    })

    await openTabEntryWithOperations({ ...baseArgs, query: 'docs/new.md', operations })

    expect(operations.statRuntimePath).toHaveBeenCalledWith(baseArgs.runtimeContext, '/repo/docs')
    expect(operations.createRuntimePath).toHaveBeenLastCalledWith(
      baseArgs.runtimeContext,
      '/repo/docs/new.md',
      'file'
    )
    expect(operations.openFile).toHaveBeenCalled()
  })

  it('rejects invalid new file paths before creating parent directories', async () => {
    const operations = makeOperations()

    await expect(
      openTabEntryWithOperations({ ...baseArgs, query: '../escape.md', operations })
    ).rejects.toThrow('File paths cannot contain . or .. segments.')

    expect(operations.createRuntimePath).not.toHaveBeenCalled()
    expect(operations.openFile).not.toHaveBeenCalled()
  })

  it('stats and opens when create loses an EEXIST race to a file', async () => {
    const operations = makeOperations({
      createRuntimePath: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('EEXIST: file already exists'))
    })

    await openTabEntryWithOperations({ ...baseArgs, query: 'docs/race.md', operations })

    expect(operations.statRuntimePath).toHaveBeenCalledWith(
      baseArgs.runtimeContext,
      '/repo/docs/race.md'
    )
    expect(operations.openFile).toHaveBeenCalled()
  })

  it('routes paired runtime browser creation through the web session API', async () => {
    const operations = makeOperations({
      isWebRuntimeSessionActive: vi.fn().mockReturnValue(true)
    })

    await openTabEntryWithOperations({
      ...baseArgs,
      query: 'https://example.com',
      activeRuntimeEnvironmentId: 'runtime-1',
      operations
    })

    expect(operations.createWebRuntimeSessionBrowserTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'runtime-1',
      url: 'https://example.com/',
      targetGroupId: 'group-1'
    })
    expect(operations.createBrowserTab).not.toHaveBeenCalled()
  })
})
