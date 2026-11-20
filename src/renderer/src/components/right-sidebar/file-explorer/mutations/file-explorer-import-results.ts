import { getRelativePathInsideRoot } from '@/lib/path'
import { toast } from 'sonner'
import { importExternalPathsToRuntime } from '@/runtime/files/imports/runtime-file-import-client'
import {
  describeSharedDropFailureReason,
  describeSharedDropSkipReason
} from '@/lib/files/drop/drop-skip-reason-copy'
import type { Translate } from '@/i18n/use-translate'
import type { FileExplorerOperationGuard } from '../navigation/file-explorer-operation-owner'

type FileExplorerImportDestination = {
  worktreeId: string
  worktreePath: string
  destinationDir: string
  guard: FileExplorerOperationGuard
}

export async function importPreparedFileExplorerPaths(
  paths: string[],
  destination: FileExplorerImportDestination,
  {
    refreshDir,
    setSelectedPath,
    getShownScope,
    t
  }: {
    refreshDir: (dirPath: string) => Promise<void>
    setSelectedPath: (path: string | null) => void
    getShownScope: () => { worktreeId: string | null; displayRootPath: string | null }
    t: Translate
  }
): Promise<string[]> {
  if (paths.length === 0) {
    return []
  }
  const { destinationDir, guard } = destination
  guard.assertCurrent()
  const { results } = await importExternalPathsToRuntime(
    {
      target: guard.route.target,
      worktreeId: destination.worktreeId,
      worktreePath: destination.worktreePath,
      connectionId: guard.route.connectionId,
      expectedExecutionHostId: guard.route.expectedExecutionHostId,
      expectedSshTargetId: guard.route.expectedSshTargetId,
      expectedSshConnectionGeneration: guard.route.expectedSshConnectionGeneration
    },
    paths,
    destinationDir,
    { assertCurrent: guard.assertCurrent }
  )

  await refreshDir(destinationDir)

  const imported = results.filter((result) => result.status === 'imported')
  const skipped = results.filter((result) => result.status === 'skipped')
  const failed = results.filter((result) => result.status === 'failed')
  const shown = getShownScope()
  if (
    imported.length > 0 &&
    shown.worktreeId === destination.worktreeId &&
    getRelativePathInsideRoot(imported[0].destPath, shown.displayRootPath) !== null
  ) {
    setSelectedPath(imported[0].destPath)
  }

  if (failed.length > 0) {
    toast.error(
      t(
        'auto.components.right.sidebar.useFileExplorerImport.importFailedCount',
        'Failed to import {{count}} files.',
        { count: failed.length, defaultValue_one: 'Failed to import {{count}} file.' }
      ),
      { description: describeSharedDropFailureReason(failed) }
    )
  } else if (skipped.length > 0 && imported.length === 0) {
    toast.error(
      t(
        'auto.components.right.sidebar.useFileExplorerImport.importSkippedCount',
        'Skipped {{count}} files.',
        { count: skipped.length, defaultValue_one: 'Skipped {{count}} file.' }
      ),
      { description: describeSharedDropSkipReason(skipped) }
    )
  }
  return imported.map((result) => result.destPath)
}
