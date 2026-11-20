import { joinPath } from '@/lib/path'
import { normalizeRelativePath } from '../../../../../../shared/file-access/cross-platform-path'
import { filterEntries } from '../../../sidebar/host-path-browser/remote-file-browser-entry-actions'
import type { DirEntry } from '../../../../../../shared/file-listing/directory-entry'
import type {
  HostBrowseEntryResolution,
  HostDirectoryListing
} from '../../../../../../shared/file-listing/host-directory-browse'
import type { RuntimeTerminalPathResolution } from '../../../../../../shared/terminal/runtime-terminal-file-path'
import { browseRuntimeServerDirectory } from '@/runtime/files/reads/runtime-server-directory-browser'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { hostAbsentRefusal } from '../../../terminal-pane/host-files/host-file-refusal'
import type { FileExplorerOperationOwner } from '../tree/file-explorer-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'

export type HostBrowseSource =
  | { kind: 'local' }
  | { kind: 'runtime'; environmentId: string; executionHostId: ExecutionHostId }

/** A host's verdict on a clicked entry; `grantId` is the host's single-file read grant. */
export type HostEntryResolution = HostBrowseEntryResolution & { grantId?: string }

/** Null when Host mode cannot browse this workspace's host from this client. */
export function getHostBrowseSource(
  owner: FileExplorerOperationOwner,
  hasDesktopHostBrowse: boolean
): HostBrowseSource | null {
  // Why: SSH workspaces run on the host's runtime; a bare SSH owner has no file provider to open with.
  if (owner.kind === 'runtime') {
    return {
      kind: 'runtime',
      environmentId: owner.environmentId,
      executionHostId: owner.executionHostId
    }
  }
  return owner.kind === 'local' && hasDesktopHostBrowse ? { kind: 'local' } : null
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
  return source.kind === 'local'
    ? requireDesktopFs().browseHostDir({ dirPath })
    : browseRuntimeServerDirectory(source.environmentId, dirPath)
}

async function listsAsDirectory(environmentId: string, path: string): Promise<boolean> {
  try {
    await browseRuntimeServerDirectory(environmentId, path)
    return true
  } catch {
    return false
  }
}

export async function resolveHostEntry(
  source: HostBrowseSource,
  entryPath: string,
  entry: DirEntry,
  workspace: { worktreeId: string; worktreePath: string }
): Promise<HostEntryResolution> {
  if (entry.isDirectory) {
    return { kind: 'directory', realPath: entryPath, workspaceRelativePath: null }
  }
  if (source.kind === 'local') {
    return requireDesktopFs().resolveHostBrowseEntry({
      targetPath: entryPath,
      workspaceRoot: workspace.worktreePath
    })
  }
  const resolved = await callRuntimeRpc<RuntimeTerminalPathResolution>(
    { kind: 'environment', environmentId: source.environmentId },
    'files.resolveTerminalPath',
    { worktree: toRuntimeWorktreeSelector(workspace.worktreeId), pathText: entryPath }
  )
  if (!resolved.exists) {
    if (resolved.relativePath !== null) {
      throw new Error(`ENOENT: not found: ${entryPath}`)
    }
    // Why: hosts without outside-file grants answer "absent" for every path outside their
    // workspaces, so a symlinked folder there is only provable by listing it.
    if (entry.isSymlink && (await listsAsDirectory(source.environmentId, entryPath))) {
      return { kind: 'directory', realPath: entryPath, workspaceRelativePath: null }
    }
    throw await hostAbsentRefusal(source.environmentId, resolved.absolutePath ?? entryPath)
  }
  const realPath = resolved.absolutePath ?? entryPath
  const target = resolved.openTarget
  if (resolved.isDirectory) {
    return { kind: 'directory', realPath, workspaceRelativePath: null }
  }
  if (target?.kind === 'worktree-file') {
    return { kind: 'file', realPath, workspaceRelativePath: target.relativePath }
  }
  if (target?.kind === 'absolute-file') {
    // Why: the grant is bound to the host's canonical path, so the tab must read that path.
    return {
      kind: 'file',
      realPath: target.absolutePath,
      workspaceRelativePath: null,
      grantId: target.grantId
    }
  }
  return { kind: 'unsupported', realPath, workspaceRelativePath: null }
}

export type HostFileOpenPlan =
  | { kind: 'workspace'; filePath: string; relativePath: string }
  | { kind: 'external'; filePath: string; grantId?: string }

// Why: ownership follows main's canonical verdict, so a workspace symlink that leaves the
// workspace stays read-only and one pointing in reuses the tree's tab.
export function planHostFileOpen({
  worktreePath,
  entryPath,
  workspaceRelativePath,
  realPath,
  grantId
}: {
  worktreePath: string
  entryPath: string
  workspaceRelativePath: string | null
  realPath?: string
  grantId?: string
}): HostFileOpenPlan {
  return workspaceRelativePath
    ? {
        kind: 'workspace',
        filePath: joinPath(worktreePath, workspaceRelativePath),
        relativePath: normalizeRelativePath(workspaceRelativePath)
      }
    : grantId && realPath
      ? { kind: 'external', filePath: realPath, grantId }
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
