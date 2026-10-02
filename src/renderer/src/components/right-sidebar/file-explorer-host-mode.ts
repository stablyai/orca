import { joinPath, normalizeRelativePath } from '@/lib/path'
import { filterEntries } from '../sidebar/remote-file-browser-helpers'
import type {
  DirEntry,
  HostBrowseEntryResolution,
  HostDirectoryListing
} from '../../../../shared/filesystem-entry-types'
import type { FileExplorerOperationOwner } from './file-explorer-types'

export type HostBrowseSource = { kind: 'local' } | { kind: 'ssh'; connectionId: string }

/** Null when Host mode cannot browse this workspace's host from this client. */
export function getHostBrowseSource(
  owner: FileExplorerOperationOwner,
  hasDesktopHostBrowse: boolean
): HostBrowseSource | null {
  // Why: the web client stubs ssh.browseDir and has no entry resolver; paired servers are out of scope.
  if (!hasDesktopHostBrowse) {
    return null
  }
  if (owner.kind === 'local') {
    return { kind: 'local' }
  }
  return owner.kind === 'ssh' ? { kind: 'ssh', connectionId: owner.connectionId } : null
}

export function hasDesktopHostBrowseApi(): boolean {
  return (
    typeof window.api.fs.browseHostDir === 'function' &&
    typeof window.api.fs.resolveHostBrowseEntry === 'function'
  )
}

function requireDesktopFs(): Required<
  Pick<Window['api']['fs'], 'browseHostDir' | 'resolveHostBrowseEntry'>
> {
  const { browseHostDir, resolveHostBrowseEntry } = window.api.fs
  if (!browseHostDir || !resolveHostBrowseEntry) {
    throw new Error('Host browsing is not available in this client')
  }
  return { browseHostDir, resolveHostBrowseEntry }
}

export async function fetchHostDirectoryListing(
  source: HostBrowseSource,
  dirPath: string
): Promise<HostDirectoryListing> {
  if (source.kind === 'local') {
    return requireDesktopFs().browseHostDir({ dirPath })
  }
  const listing = await window.api.ssh.browseDir({ targetId: source.connectionId, dirPath })
  // Why: `ls -p` cannot mark symlinks; non-directories are classified on click instead.
  return { ...listing, entries: listing.entries.map((entry) => ({ ...entry, isSymlink: false })) }
}

export function resolveHostEntry(
  source: HostBrowseSource,
  entryPath: string,
  entry: DirEntry,
  workspaceRoot: string
): Promise<HostBrowseEntryResolution> {
  if (entry.isDirectory) {
    return Promise.resolve({ kind: 'directory', realPath: entryPath, workspaceRelativePath: null })
  }
  return requireDesktopFs().resolveHostBrowseEntry({
    targetPath: entryPath,
    workspaceRoot,
    ...(source.kind === 'ssh' ? { connectionId: source.connectionId } : {})
  })
}

export type HostFileOpenPlan =
  | { kind: 'workspace'; filePath: string; relativePath: string }
  | { kind: 'external'; filePath: string }

// Why: ownership follows main's canonical verdict, so a workspace symlink that leaves the
// workspace stays read-only and one pointing in reuses the tree's tab.
export function planHostFileOpen({
  worktreePath,
  entryPath,
  workspaceRelativePath
}: {
  worktreePath: string
  entryPath: string
  workspaceRelativePath: string | null
}): HostFileOpenPlan {
  return workspaceRelativePath
    ? {
        kind: 'workspace',
        filePath: joinPath(worktreePath, workspaceRelativePath),
        relativePath: normalizeRelativePath(workspaceRelativePath)
      }
    : { kind: 'external', filePath: entryPath }
}

export function filterHostEntries(
  entries: DirEntry[],
  query: string,
  showDotfiles: boolean
): DirEntry[] {
  return filterEntries(
    showDotfiles ? entries : entries.filter((entry) => !entry.name.startsWith('.')),
    query
  )
}
