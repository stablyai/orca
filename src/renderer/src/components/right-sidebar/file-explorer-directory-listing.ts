import { useAppStore } from '@/store'
import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { sortDirEntries } from '../../../../shared/file-name-sort'
import { readRuntimeDirectory } from '@/runtime/runtime-file-mutation-client'
import type { FileExplorerOperationOwner, TreeNode } from './file-explorer-types'
import { shouldIncludeFileExplorerEntry } from './file-explorer-entries'
import {
  getFileExplorerOperationOwner,
  getFileExplorerOwnerUnresolvedMessage,
  getFileExplorerOperationRoute
} from './file-explorer-operation-owner'

export type FileExplorerDirectoryListing = {
  entries: DirEntry[]
  operationOwner: FileExplorerOperationOwner
}

export function fileExplorerEntriesToTreeNodes(
  entries: DirEntry[],
  dirPath: string,
  depth: number,
  worktreePath: string | null,
  operationOwner: FileExplorerOperationOwner
): TreeNode[] {
  return entries.filter(shouldIncludeFileExplorerEntry).map((entry) => {
    const path = joinPath(dirPath, entry.name)
    const workspaceRelativePath = getRelativePathInsideRoot(path, worktreePath)
    return {
      name: entry.name,
      path,
      relativePath: workspaceRelativePath ?? path,
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
      depth: depth + 1,
      operationOwner
    }
  })
}

export async function readFileExplorerDirectory(
  activeWorktreeId: string | null | undefined,
  worktreePath: string | null,
  dirPath: string
): Promise<FileExplorerDirectoryListing> {
  const operationOwner = getFileExplorerOperationOwner(activeWorktreeId)
  const route = getFileExplorerOperationRoute(operationOwner)
  if (!route) {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  const followSymlinks = useAppStore.getState().settings?.followSymlinkedDirectories === true
  const outsideWorkspace = getRelativePathInsideRoot(dirPath, worktreePath) === null
  const options =
    followSymlinks || outsideWorkspace
      ? {
          ...(followSymlinks ? { followSymlinks: true } : {}),
          ...(outsideWorkspace ? { access: { kind: 'user-directory' as const } } : {})
        }
      : undefined
  const entries = await readRuntimeDirectory(
    {
      target: route.target,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId: route.connectionId
    },
    dirPath,
    options
  )
  // Why: remote-runtime and paired-web routes return the host's order verbatim,
  // and an older host may still sort lexicographically; re-sorting an already
  // sorted local listing is near-free (adaptive sort).
  return {
    entries: sortDirEntries(entries),
    operationOwner
  }
}
