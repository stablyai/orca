import { describe, expect, it, vi } from 'vitest'
import {
  openTabEntryWithOperations,
  TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE,
  type TabEntryOperations
} from './tab-create-entry-action'

const readyFiles = (files: string[]) => ({ files, loading: false, loadError: null })

describe('openTabEntryWithOperations', () => {
  function makeOperations(overrides: Partial<TabEntryOperations> = {}): TabEntryOperations {
    return {
      createRuntimePath: vi.fn().mockResolvedValue(undefined),
      openWorkspaceBrowserTab: vi.fn().mockResolvedValue(undefined),
      openFile: vi.fn(),
      statRuntimePath: vi.fn().mockResolvedValue({ size: 1, isDirectory: false, mtime: 1 }),
      authorizeExternalPath: vi.fn().mockResolvedValue(undefined),
      assertAbsolutePathAllowed: vi.fn(),
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
    allowAbsolutePaths: true,
    localPlatform: 'posix' as const,
    searchEngine: 'google' as const
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

  it('routes URL classifications through the workspace browser opener', async () => {
    const operations = makeOperations()

    await openTabEntryWithOperations({
      ...baseArgs,
      query: 'https://example.com',
      operations
    })

    expect(operations.openWorkspaceBrowserTab).toHaveBeenCalledWith({
      workspaceId: 'wt-1',
      url: 'https://example.com/',
      targetGroupId: 'group-1',
      intent: { kind: 'url' }
    })
  })

  it('builds a search URL from the selected immutable classification', async () => {
    const operations = makeOperations()

    await openTabEntryWithOperations({
      ...baseArgs,
      query: 'different query',
      classification: { kind: 'search', engine: 'duckduckgo', query: 'react hooks' },
      operations
    })

    expect(operations.openWorkspaceBrowserTab).toHaveBeenCalledWith({
      workspaceId: 'wt-1',
      url: 'https://duckduckgo.com/?q=react%20hooks',
      targetGroupId: 'group-1',
      intent: { kind: 'search', engine: 'duckduckgo' }
    })
  })

  it('uses plain Kagi search URLs and the fallback classifier engine', async () => {
    const operations = makeOperations()

    await openTabEntryWithOperations({
      ...baseArgs,
      query: 'private project',
      searchEngine: 'kagi',
      operations
    })

    expect(operations.openWorkspaceBrowserTab).toHaveBeenCalledWith({
      workspaceId: 'wt-1',
      url: 'https://kagi.com/search?q=private%20project',
      targetGroupId: 'group-1',
      intent: { kind: 'search', engine: 'kagi' }
    })
  })

  it('uses a configured Kagi private-session link', async () => {
    const operations = makeOperations()

    await openTabEntryWithOperations({
      ...baseArgs,
      query: 'private project',
      searchEngine: 'kagi',
      searchUrlOptions: {
        kagiSessionLink: 'https://kagi.com/search?token=secret'
      },
      operations
    })

    expect(operations.openWorkspaceBrowserTab).toHaveBeenCalledWith({
      workspaceId: 'wt-1',
      url: 'https://kagi.com/search?token=secret&q=private+project',
      targetGroupId: 'group-1',
      intent: { kind: 'search', engine: 'kagi' }
    })
  })

  it('authorizes and opens absolute local files in the target group', async () => {
    const operations = makeOperations()

    await openTabEntryWithOperations({
      ...baseArgs,
      classification: { kind: 'absolute-file', filePath: '/tmp/notes.md' },
      query: '/tmp/notes.md',
      operations
    })

    expect(operations.authorizeExternalPath).toHaveBeenCalledWith({ targetPath: '/tmp/notes.md' })
    expect(operations.statRuntimePath).toHaveBeenCalledWith(
      baseArgs.runtimeContext,
      '/tmp/notes.md'
    )
    expect(operations.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/notes.md',
        relativePath: '/tmp/notes.md',
        worktreeId: 'wt-1'
      }),
      { preview: false, targetGroupId: 'group-1' }
    )
  })

  it('normalizes worktree absolute paths to relative paths before opening', async () => {
    const operations = makeOperations()

    await openTabEntryWithOperations({
      ...baseArgs,
      classification: { kind: 'absolute-file', filePath: '/repo/src/index.ts' },
      query: '/repo/src/index.ts',
      operations
    })

    expect(operations.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/src/index.ts',
        relativePath: 'src/index.ts'
      }),
      { preview: false, targetGroupId: 'group-1' }
    )
  })

  it('rejects absolute paths when remote workspaces disallow them', async () => {
    const operations = makeOperations()

    await expect(
      openTabEntryWithOperations({
        ...baseArgs,
        allowAbsolutePaths: false,
        classification: { kind: 'absolute-file', filePath: '/tmp/notes.md' },
        query: '/tmp/notes.md',
        operations
      })
    ).rejects.toThrow(TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE)

    expect(operations.authorizeExternalPath).not.toHaveBeenCalled()
    expect(operations.statRuntimePath).not.toHaveBeenCalled()
    expect(operations.createRuntimePath).not.toHaveBeenCalled()
    expect(operations.openFile).not.toHaveBeenCalled()
  })

  it('rejects Windows path syntax before native POSIX authorization', async () => {
    const operations = makeOperations()

    await expect(
      openTabEntryWithOperations({
        ...baseArgs,
        classification: { kind: 'absolute-file', filePath: 'C:\\tmp\\notes.md' },
        query: 'C:\\tmp\\notes.md',
        operations
      })
    ).rejects.toThrow('Enter an absolute path for this computer.')

    expect(operations.authorizeExternalPath).not.toHaveBeenCalled()
    expect(operations.statRuntimePath).not.toHaveBeenCalled()
    expect(operations.openFile).not.toHaveBeenCalled()
  })

  it('normalizes and opens Windows drive paths on Windows', async () => {
    const operations = makeOperations()

    await openTabEntryWithOperations({
      ...baseArgs,
      localPlatform: 'windows',
      worktreePath: 'C:/repo',
      classification: { kind: 'absolute-file', filePath: 'C:\\tmp\\notes.md' },
      query: 'C:\\tmp\\notes.md',
      operations
    })

    expect(operations.authorizeExternalPath).toHaveBeenCalledWith({
      targetPath: 'C:/tmp/notes.md'
    })
    expect(operations.statRuntimePath).toHaveBeenCalledWith(
      baseArgs.runtimeContext,
      'C:/tmp/notes.md'
    )
  })

  it('stops after authorization when ownership becomes remote or ambiguous', async () => {
    let releaseAuthorization: (() => void) | undefined
    const authorization = new Promise<void>((resolve) => {
      releaseAuthorization = resolve
    })
    let allowed = true
    const operations = makeOperations({
      authorizeExternalPath: vi.fn(() => authorization),
      assertAbsolutePathAllowed: vi.fn(() => {
        if (!allowed) {
          throw new Error(TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE)
        }
      })
    })

    const opening = openTabEntryWithOperations({
      ...baseArgs,
      classification: { kind: 'absolute-file', filePath: '/tmp/notes.md' },
      query: '/tmp/notes.md',
      operations
    })
    await vi.waitFor(() => expect(operations.authorizeExternalPath).toHaveBeenCalledTimes(1))
    const rejection = expect(opening).rejects.toThrow(
      TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE
    )
    allowed = false
    releaseAuthorization?.()
    await rejection

    expect(operations.statRuntimePath).not.toHaveBeenCalled()
    expect(operations.openFile).not.toHaveBeenCalled()
  })
})
