import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchHostDirectoryListing,
  filterHostEntries,
  getHostBrowseSource,
  planHostFileOpen,
  resolveHostEntry
} from './file-explorer-host-mode'

const { browseRuntimeDir, callRuntimeRpc, hostAbsentRefusal } = vi.hoisted(() => ({
  browseRuntimeDir: vi.fn(),
  callRuntimeRpc: vi.fn(),
  hostAbsentRefusal: vi.fn()
}))
vi.mock('../../../terminal-pane/host-files/host-file-refusal', () => ({ hostAbsentRefusal }))
vi.mock('@/runtime/files/reads/runtime-server-directory-browser', () => ({
  browseRuntimeServerDirectory: browseRuntimeDir
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))

const browseHostDir = vi.fn()
const resolveHostBrowseEntry = vi.fn()
const listFiles = vi.fn()
const search = vi.fn()

beforeEach(() => {
  for (const mock of [
    browseHostDir,
    resolveHostBrowseEntry,
    listFiles,
    search,
    browseRuntimeDir,
    callRuntimeRpc,
    hostAbsentRefusal
  ]) {
    mock.mockReset()
  }
  vi.stubGlobal('window', {
    api: { fs: { browseHostDir, resolveHostBrowseEntry, listFiles, search } }
  })
})

const runtime = {
  kind: 'runtime',
  environmentId: 'env-1',
  executionHostId: 'ssh:box'
} as const

const file = { name: 'notes.txt', isDirectory: false, isSymlink: false }
const link = { name: 'link', isDirectory: false, isSymlink: true }
const dir = { name: 'src', isDirectory: true, isSymlink: false }

describe('getHostBrowseSource', () => {
  it('browses local workspaces on the desktop client and runtime-owned ones anywhere', () => {
    expect(getHostBrowseSource({ kind: 'local' }, true)).toEqual({ kind: 'local' })
    expect(getHostBrowseSource(runtime, true)).toEqual(runtime)
    expect(getHostBrowseSource(runtime, false)).toEqual(runtime)
  })

  it('is unavailable for local without the desktop APIs, bare SSH owners, and while unresolved', () => {
    expect(getHostBrowseSource({ kind: 'local' }, false)).toBeNull()
    expect(getHostBrowseSource({ kind: 'ssh', connectionId: 'ssh-1' }, true)).toBeNull()
    expect(getHostBrowseSource({ kind: 'unresolved' }, true)).toBeNull()
  })
})

describe('fetchHostDirectoryListing', () => {
  it('lists local directories through the names-only host channel', async () => {
    const listing = { resolvedPath: '/home/allen', entries: [dir], pathFlavor: 'posix' }
    browseHostDir.mockResolvedValue(listing)

    await expect(fetchHostDirectoryListing({ kind: 'local' }, '/home/allen')).resolves.toBe(listing)
    expect(browseHostDir).toHaveBeenCalledWith({ dirPath: '/home/allen' })
    expect(listFiles).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
  })

  it('lists runtime-owned hosts through the host runtime, not the desktop channel', async () => {
    const listing = { resolvedPath: '/Data2/allen', entries: [dir], pathFlavor: 'posix' }
    browseRuntimeDir.mockResolvedValue(listing)

    await expect(fetchHostDirectoryListing(runtime, '/Data2/allen')).resolves.toBe(listing)
    expect(browseRuntimeDir).toHaveBeenCalledWith('env-1', '/Data2/allen')
    expect(browseHostDir).not.toHaveBeenCalled()
  })
})

describe('resolveHostEntry', () => {
  const root = '/home/allen/codes'
  const workspace = { worktreeId: 'wt-1', worktreePath: root }
  const resolution = (overrides: Record<string, unknown>) => ({
    worktree: 'wt-1',
    relativePath: null,
    absolutePath: '/home/allen/x',
    exists: true,
    isDirectory: false,
    ...overrides
  })

  it('trusts listed directories without a round trip', async () => {
    await expect(
      resolveHostEntry({ kind: 'local' }, '/home/allen/src', dir, workspace)
    ).resolves.toEqual({
      kind: 'directory',
      realPath: '/home/allen/src',
      workspaceRelativePath: null
    })
    expect(resolveHostBrowseEntry).not.toHaveBeenCalled()
  })

  it('classifies local non-directories in the main process', async () => {
    const resolved = { kind: 'directory', realPath: '/mnt/data', workspaceRelativePath: null }
    resolveHostBrowseEntry.mockResolvedValue(resolved)

    await expect(
      resolveHostEntry({ kind: 'local' }, '/home/allen/link', link, workspace)
    ).resolves.toEqual(resolved)
    expect(resolveHostBrowseEntry).toHaveBeenCalledWith({
      targetPath: '/home/allen/link',
      workspaceRoot: root
    })
  })

  it('asks the host runtime about the clicked path in this workspace, never main', async () => {
    callRuntimeRpc.mockResolvedValue(resolution({ isDirectory: true }))

    await expect(resolveHostEntry(runtime, '/home/allen/x', link, workspace)).resolves.toEqual({
      kind: 'directory',
      realPath: '/home/allen/x',
      workspaceRelativePath: null
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'files.resolveTerminalPath',
      { worktree: 'id:wt-1', pathText: '/home/allen/x' }
    )
    expect(resolveHostBrowseEntry).not.toHaveBeenCalled()
  })

  it('opens a runtime file inside the workspace by its workspace path', async () => {
    callRuntimeRpc.mockResolvedValue(
      resolution({
        relativePath: 'src/a.ts',
        absolutePath: `${root}/src/a.ts`,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'src/a.ts',
          absolutePath: `${root}/src/a.ts`
        }
      })
    )

    await expect(resolveHostEntry(runtime, `${root}/src/a.ts`, file, workspace)).resolves.toEqual({
      kind: 'file',
      realPath: `${root}/src/a.ts`,
      workspaceRelativePath: 'src/a.ts'
    })
  })

  it("carries the host's single-file grant and canonical path for an outside file", async () => {
    callRuntimeRpc.mockResolvedValue(
      resolution({
        absolutePath: '/srv/real/notes.txt',
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: '/srv/real/notes.txt',
          grantId: 'grant-1'
        }
      })
    )

    await expect(resolveHostEntry(runtime, '/home/allen/x', file, workspace)).resolves.toEqual({
      kind: 'file',
      realPath: '/srv/real/notes.txt',
      workspaceRelativePath: null,
      grantId: 'grant-1'
    })
  })

  it('reports a vanished workspace file as missing and an ungranted one as unsupported', async () => {
    callRuntimeRpc.mockResolvedValueOnce(
      resolution({
        exists: false,
        relativePath: 'src/gone.ts',
        absolutePath: `${root}/src/gone.ts`
      })
    )
    await expect(resolveHostEntry(runtime, `${root}/src/gone.ts`, file, workspace)).rejects.toThrow(
      /ENOENT/
    )
    expect(hostAbsentRefusal).not.toHaveBeenCalled()

    callRuntimeRpc.mockResolvedValueOnce(resolution({}))
    await expect(resolveHostEntry(runtime, '/home/allen/x', file, workspace)).resolves.toEqual({
      kind: 'unsupported',
      realPath: '/home/allen/x',
      workspaceRelativePath: null
    })
  })
})

describe('resolveHostEntry outside the workspace', () => {
  it("lets the host's capability decide what an absent outside file means", async () => {
    const refusal = new Error('Update Orca on hostbox to open files outside its workspaces')
    hostAbsentRefusal.mockResolvedValue(refusal)
    callRuntimeRpc.mockResolvedValue({
      worktree: 'wt-1',
      relativePath: null,
      absolutePath: '/home/allen/notes.txt',
      exists: false,
      isDirectory: false
    })

    await expect(
      resolveHostEntry(runtime, '/home/allen/notes.txt', file, {
        worktreeId: 'wt-1',
        worktreePath: '/home/allen/codes'
      })
    ).rejects.toBe(refusal)
    expect(hostAbsentRefusal).toHaveBeenCalledWith('env-1', '/home/allen/notes.txt')
  })

  it('enters an outside folder symlink that such a host can list, and refuses one it cannot', async () => {
    const workspace = { worktreeId: 'wt-1', worktreePath: '/home/allen/codes' }
    callRuntimeRpc.mockResolvedValue({
      worktree: 'wt-1',
      relativePath: null,
      absolutePath: '/home/allen/linkdir',
      exists: false,
      isDirectory: false
    })
    browseRuntimeDir.mockResolvedValueOnce({
      resolvedPath: '/srv/x',
      entries: [],
      pathFlavor: 'posix'
    })

    await expect(
      resolveHostEntry(runtime, '/home/allen/linkdir', link, workspace)
    ).resolves.toEqual({
      kind: 'directory',
      realPath: '/home/allen/linkdir',
      workspaceRelativePath: null
    })
    expect(browseRuntimeDir).toHaveBeenCalledWith('env-1', '/home/allen/linkdir')
    expect(hostAbsentRefusal).not.toHaveBeenCalled()

    const refusal = new Error('refused')
    hostAbsentRefusal.mockResolvedValue(refusal)
    browseRuntimeDir.mockRejectedValueOnce(new Error('ENOTDIR'))
    await expect(resolveHostEntry(runtime, '/home/allen/linkdir', link, workspace)).rejects.toBe(
      refusal
    )
    browseRuntimeDir.mockClear()
    await expect(resolveHostEntry(runtime, '/home/allen/notes.txt', file, workspace)).rejects.toBe(
      refusal
    )
    expect(browseRuntimeDir, 'a plain file is never probed').not.toHaveBeenCalled()
  })
})

describe('planHostFileOpen', () => {
  it('opens workspace files through the writable tree path, including symlinks pointing in', () => {
    expect(
      planHostFileOpen({
        worktreePath: '/home/allen/codes',
        entryPath: '/home/allen/shortcut/a.ts',
        workspaceRelativePath: 'src/a.ts'
      })
    ).toEqual({
      kind: 'workspace',
      filePath: '/home/allen/codes/src/a.ts',
      relativePath: 'src/a.ts'
    })
  })

  it('keeps a workspace symlink that leaves the workspace read-only (canonical verdict wins)', () => {
    expect(
      planHostFileOpen({
        worktreePath: '/home/allen/codes',
        entryPath: '/home/allen/codes/link-out',
        workspaceRelativePath: null
      })
    ).toEqual({ kind: 'external', filePath: '/home/allen/codes/link-out' })
  })

  it('opens a granted outside file at the canonical path its grant is bound to', () => {
    expect(
      planHostFileOpen({
        worktreePath: '/home/allen/codes',
        entryPath: '/home/allen/link-out',
        workspaceRelativePath: null,
        realPath: '/srv/real/notes.txt',
        grantId: 'grant-1'
      })
    ).toEqual({ kind: 'external', filePath: '/srv/real/notes.txt', grantId: 'grant-1' })
  })

  it('keeps Windows workspace files on the workspace separator', () => {
    expect(
      planHostFileOpen({
        worktreePath: 'C:\\Users\\allen\\codes',
        entryPath: 'C:\\Users\\allen\\codes\\src\\a.ts',
        workspaceRelativePath: 'src\\a.ts'
      })
    ).toEqual({
      kind: 'workspace',
      filePath: 'C:\\Users\\allen\\codes\\src\\a.ts',
      relativePath: 'src/a.ts'
    })
  })
})

describe('filterHostEntries', () => {
  it('filters only the listed folder by name and honors hidden dotfiles', () => {
    const entries = [dir, file, { name: '.ssh', isDirectory: true, isSymlink: false }]
    expect(filterHostEntries(entries, 'NOTES', true)).toEqual([file])
    expect(filterHostEntries(entries, '', false)).toEqual([dir, file])
    expect(filterHostEntries(entries, 'ssh', true)).toHaveLength(1)
  })
})
