import { useLayoutEffect, useRef } from 'react'
import { toast } from 'sonner'
import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-import-client'
import { translate } from '@/i18n/i18n'
import type { FileExplorerOperationOwner } from './file-explorer-types'
import {
  captureFileExplorerOperationGuard,
  type FileExplorerOperationGuard
} from './file-explorer-operation-owner'

export type FileExplorerImportParams = {
  worktreeId: string | null
  worktreePath: string | null
  displayRootPath?: string | null
  refreshDir: (dirPath: string) => Promise<void>
  setSelectedPath: (path: string | null) => void
  revealPath?: (path: string) => void
  operationOwner?: FileExplorerOperationOwner
}

export type FileExplorerImportDestination = {
  worktreeId: string
  worktreePath: string
  destinationDir: string
  guard: FileExplorerOperationGuard
}

export function useFileExplorerImportOperation({
  worktreeId,
  worktreePath,
  displayRootPath = worktreePath,
  refreshDir,
  setSelectedPath,
  revealPath,
  operationOwner
}: FileExplorerImportParams) {
  const shownRef = useRef({ worktreeId, worktreePath, displayRootPath })
  const mountedRef = useRef(false)
  useLayoutEffect(() => {
    shownRef.current = { worktreeId, worktreePath, displayRootPath }
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [worktreeId, worktreePath, displayRootPath])

  function captureDestination(
    destinationDir: string,
    owner = operationOwner
  ): FileExplorerImportDestination | null {
    if (
      !mountedRef.current ||
      !worktreeId ||
      !worktreePath ||
      !displayRootPath ||
      getRelativePathInsideRoot(displayRootPath, worktreePath) === null ||
      getRelativePathInsideRoot(destinationDir, displayRootPath) === null
    ) {
      return null
    }
    return {
      worktreeId,
      worktreePath,
      destinationDir,
      guard: captureFileExplorerOperationGuard(worktreeId, owner)
    }
  }

  function isDestinationShown(destination: FileExplorerImportDestination): boolean {
    const shown = shownRef.current
    if (
      !mountedRef.current ||
      shown.worktreeId !== destination.worktreeId ||
      shown.worktreePath !== destination.worktreePath ||
      getRelativePathInsideRoot(destination.destinationDir, shown.displayRootPath) === null
    ) {
      return false
    }
    try {
      destination.guard.assertCurrent()
      return true
    } catch {
      return false
    }
  }

  async function importPaths(
    destination: FileExplorerImportDestination,
    paths: string[],
    options?: { requireExistingDestination?: boolean; onImported?: (path: string) => void }
  ) {
    const { destinationDir, guard } = destination
    guard.assertCurrent()
    const { results } = await importExternalPathsToRuntime(
      {
        ...guard.route,
        worktreeId: destination.worktreeId,
        worktreePath: destination.worktreePath
      },
      paths,
      destinationDir,
      {
        ...(options?.requireExistingDestination ? { requireExistingDestination: true } : {}),
        assertCurrent: guard.assertCurrent
      }
    )

    const imported = results.filter((result) => result.status === 'imported')
    const skipped = results.filter((result) => result.status === 'skipped')
    const failed = results.filter((result) => result.status === 'failed')
    if (imported.length > 0) {
      options?.onImported?.(imported[0].destPath)
    }
    if (isDestinationShown(destination)) {
      await refreshDir(destinationDir)
    }

    // A refresh can yield while the user switches workspaces or the owner reconnects.
    if (
      imported.length > 0 &&
      isDestinationShown(destination) &&
      getRelativePathInsideRoot(imported[0].destPath, shownRef.current.displayRootPath) !== null
    ) {
      const relativePath = getRelativePathInsideRoot(imported[0].destPath, destinationDir)
      if (relativePath !== null) {
        // Match the tree's path spelling when native Windows imports return backslashes.
        const selectedPath = joinPath(destinationDir, relativePath)
        setSelectedPath(selectedPath)
        revealPath?.(selectedPath)
      }
    }

    if (failed.length > 0) {
      toast.error(
        translate(
          'auto.components.right.sidebar.useFileExplorerImport.132fd0e1e9',
          'Failed to import {{value0}} {{value1}}.',
          { value0: failed.length, value1: failed.length === 1 ? 'file' : 'files' }
        )
      )
    } else if (skipped.length > 0 && imported.length === 0) {
      toast.error(
        translate(
          'auto.components.right.sidebar.useFileExplorerImport.25919b2050',
          'Skipped {{value0}} {{value1}}.',
          { value0: skipped.length, value1: skipped.length === 1 ? 'file' : 'files' }
        )
      )
    }
    return results
  }

  return { captureDestination, importPaths, isDestinationShown }
}
