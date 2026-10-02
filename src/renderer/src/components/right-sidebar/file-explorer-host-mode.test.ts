import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchHostDirectoryListing,
  filterHostEntries,
  getHostBrowseSource,
  planHostFileOpen,
  resolveHostEntry
} from './file-explorer-host-mode'

const browseHostDir = vi.fn()
const resolveHostBrowseEntry = vi.fn()
const sshBrowseDir = vi.fn()
const listFiles = vi.fn()
const search = vi.fn()
const authorizeExternalPath = vi.fn()

beforeEach(() => {
  for (const mock of [
    browseHostDir,
    resolveHostBrowseEntry,
    sshBrowseDir,
    listFiles,
    search,
    authorizeExternalPath
  ]) {
    mock.mockReset()
  }
  vi.stubGlobal('window', {
    api: {
      fs: { browseHostDir, resolveHostBrowseEntry, listFiles, search, authorizeExternalPath },
      ssh: { browseDir: sshBrowseDir }
    }
  })
})

const file = { name: 'notes.txt', isDirectory: false, isSymlink: false }
const link = { name: 'link', isDirectory: false, isSymlink: true }
const dir = { name: 'src', isDirectory: true, isSymlink: false }

describe('getHostBrowseSource', () => {
  it('browses local and SSH workspaces on the desktop client', () => {
    expect(getHostBrowseSource({ kind: 'local' }, true)).toEqual({ kind: 'local' })
    expect(getHostBrowseSource({ kind: 'ssh', connectionId: 'ssh-1' }, true)).toEqual({
      kind: 'ssh',
      connectionId: 'ssh-1'
    })
  })

  it('is unavailable without the desktop APIs, for paired servers, and while unresolved', () => {
    expect(getHostBrowseSource({ kind: 'local' }, false)).toBeNull()
    expect(getHostBrowseSource({ kind: 'ssh', connectionId: 'ssh-1' }, false)).toBeNull()
    expect(
      getHostBrowseSource(
        { kind: 'runtime', environmentId: 'env-1', executionHostId: 'runtime:env-1' },
        true
      )
    ).toBeNull()
    expect(getHostBrowseSource({ kind: 'unresolved' }, true)).toBeNull()
  })
})

describe('fetchHostDirectoryListing', () => {
  it('lists local directories through the names-only host channel', async () => {
    const listing = { resolvedPath: '/home/allen', entries: [dir], pathFlavor: 'posix' }
    browseHostDir.mockResolvedValue(listing)

    await expect(fetchHostDirectoryListing({ kind: 'local' }, '/home/allen')).resolves.toBe(listing)
    expect(browseHostDir).toHaveBeenCalledWith({ dirPath: '/home/allen' })
    expect(authorizeExternalPath).not.toHaveBeenCalled()
    expect(listFiles).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
  })

  it('lists SSH directories on the workspace host and marks entries as non-symlinks', async () => {
    sshBrowseDir.mockResolvedValue({
      resolvedPath: '/Data2/allen921103',
      entries: [{ name: 'project', isDirectory: true }],
      pathFlavor: 'posix'
    })

    await expect(
      fetchHostDirectoryListing({ kind: 'ssh', connectionId: 'ssh-1' }, '/Data2/allen921103')
    ).resolves.toEqual({
      resolvedPath: '/Data2/allen921103',
      entries: [{ name: 'project', isDirectory: true, isSymlink: false }],
      pathFlavor: 'posix'
    })
    expect(sshBrowseDir).toHaveBeenCalledWith({ targetId: 'ssh-1', dirPath: '/Data2/allen921103' })
  })
})

describe('resolveHostEntry', () => {
  const root = '/home/allen/codes'

  it('trusts listed directories without a round trip', async () => {
    await expect(
      resolveHostEntry({ kind: 'local' }, '/home/allen/src', dir, root)
    ).resolves.toEqual({
      kind: 'directory',
      realPath: '/home/allen/src',
      workspaceRelativePath: null
    })
    expect(resolveHostBrowseEntry).not.toHaveBeenCalled()
  })

  it('classifies local and SSH non-directories in the main process', async () => {
    const resolved = { kind: 'directory', realPath: '/mnt/data', workspaceRelativePath: null }
    resolveHostBrowseEntry.mockResolvedValue(resolved)

    await expect(
      resolveHostEntry({ kind: 'local' }, '/home/allen/link', link, root)
    ).resolves.toEqual(resolved)
    await resolveHostEntry({ kind: 'ssh', connectionId: 'ssh-1' }, '/home/allen/x', file, root)

    expect(resolveHostBrowseEntry).toHaveBeenNthCalledWith(1, {
      targetPath: '/home/allen/link',
      workspaceRoot: root
    })
    expect(resolveHostBrowseEntry).toHaveBeenNthCalledWith(2, {
      targetPath: '/home/allen/x',
      workspaceRoot: root,
      connectionId: 'ssh-1'
    })
    expect(authorizeExternalPath).not.toHaveBeenCalled()
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
