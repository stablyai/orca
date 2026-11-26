import { joinPath } from '@/lib/path'
import type { ImportItemResult } from '../../../../../shared/file-import/filesystem-import-result'
import { deconflictCopyName } from '../../../../../shared/file-import/import-copy-name'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'
import type { RuntimeFileOperationArgs } from '../runtime-file-client-types'
import { captureRuntimeEnvironmentRequestRevision } from '../../rpc/environment-revisions/runtime-environment-revision'
import { runtimePathExists } from '../metadata/runtime-file-metadata-client'
import {
  assertRuntimeFileMutationCapability,
  callRuntimeFileImportMutation,
  createRuntimeImportSessionGuard,
  type RuntimeFileImportSession
} from '../mutations/runtime-file-mutation-rpc'
import {
  getRemoteFileArgs,
  joinRuntimeRelativePath,
  withSshMutationExpectation,
  localAccess
} from '../runtime-file-routing'
import {
  ensureRuntimeDirectory,
  ensureRuntimeDropStagingIgnored,
  uploadRuntimeFileWithoutClobber
} from './runtime-file-upload-client'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import type { LocalFileAccess } from '../../../../../shared/file-access/local-file-access'
import { stagedRuntimeUploadByteLength } from '../../../../../shared/file-import/runtime-upload-staging-contract'

/** Per-source progress and cancel for one runtime import; aborting `signal` rejects the whole import. */
export type RuntimeImportTransfer = {
  signal: AbortSignal
  /** The staged sources in upload order; the other callbacks index into this list. */
  onStart: (sources: { sourcePath: string; name: string; byteLength: number }[]) => void
  /** Aborting it skips or stops just that source; the import goes on with the rest. */
  sourceSignal: (index: number) => AbortSignal
  /** That source's bytes the runtime acknowledged; 0 when its upload begins. */
  onProgress: (index: number, sentBytes: number) => void
  onDone: (index: number, outcome: 'uploaded' | 'failed') => void
}

export async function importExternalPathsToRuntime(
  context: RuntimeFileOperationArgs,
  sourcePaths: string[],
  destinationDir: string,
  options?: {
    ensureDestinationDir?: boolean
    assertCurrent?: () => void
    /** Local imports only; remote destinations stay root-relative. */
    access?: LocalFileAccess
    /** Remote `.orca/drops` uploads: name an extensionless image by its bytes. */
    nameExtensionlessImages?: boolean
    /** Remote uploads only; local imports copy without progress. */
    transfer?: RuntimeImportTransfer
  }
): Promise<{ results: ImportItemResult[] }> {
  const target = context.target
  if (target.kind !== 'environment' || !context.worktreeId || !context.worktreePath) {
    return window.api.fs.importExternalPaths(
      withSshMutationExpectation(context, {
        sourcePaths,
        destDir: destinationDir,
        connectionId: context.connectionId,
        ensureDir: options?.ensureDestinationDir,
        ...localAccess(context.connectionId, options?.access)
      })
    )
  }

  const destinationArgs = getRemoteFileArgs(context, destinationDir)
  if (!destinationArgs) {
    throw new Error('Destination is outside the active runtime worktree')
  }

  const expectedEnvironmentPairingRevision = captureRuntimeEnvironmentRequestRevision(
    target.environmentId
  )
  const expectedEnvironmentConnectionGeneration = getRuntimeEnvironmentConnectionGeneration(
    target.environmentId
  )
  const expectedEnvironmentRuntimeId = await assertRuntimeFileMutationCapability(
    target,
    expectedEnvironmentPairingRevision
  )
  const assertImportSessionCurrent = createRuntimeImportSessionGuard(
    target.environmentId,
    expectedEnvironmentPairingRevision,
    expectedEnvironmentConnectionGeneration,
    options?.assertCurrent
  )
  const importSession: RuntimeFileImportSession = {
    target,
    expectedEnvironmentPairingRevision,
    expectedEnvironmentConnectionGeneration,
    expectedEnvironmentRuntimeId,
    assertCurrent: assertImportSessionCurrent
  }
  importSession.assertCurrent()
  const staged = await window.api.fs.stageExternalPathsForRuntimeUpload({
    sourcePaths,
    nameExtensionlessImages: options?.nameExtensionlessImages
  })
  importSession.assertCurrent()
  const transfer = options?.transfer
  transfer?.signal.throwIfAborted()
  transfer?.onStart(
    staged.sources.flatMap((source) =>
      source.status === 'staged'
        ? [
            {
              sourcePath: source.sourcePath,
              name: source.name,
              byteLength: stagedRuntimeUploadByteLength(source)
            }
          ]
        : []
    )
  )
  let stagedIndex = -1
  const results: ImportItemResult[] = []
  const reservedNames = new Set<string>()

  await ensureRuntimeDirectory(context, destinationDir, importSession)
  await ensureRuntimeDropStagingIgnored(context, destinationDir, importSession)
  // The ignore step swallows a stale session; re-check before results that never reach the host.
  importSession.assertCurrent()

  for (const source of staged.sources) {
    if (source.status !== 'staged') {
      results.push(source)
      continue
    }
    const index = ++stagedIndex
    transfer?.signal.throwIfAborted()
    const sourceSignal = transfer?.sourceSignal(index)
    // Cancelled while it waited: neither pasted nor reported as failed.
    if (sourceSignal?.aborted) {
      continue
    }
    const uploadSignal =
      transfer && sourceSignal && AbortSignal.any([transfer.signal, sourceSignal])
    let createdDirectoryImportRoot: string | null = null
    let finishedEntryBytes = 0
    transfer?.onProgress(index, 0)
    try {
      const finalName = await deconflictCopyName(source.name, async (n) => {
        importSession.assertCurrent()
        return (
          (await runtimePathExists(
            context,
            joinPath(destinationDir, n),
            importSession.expectedEnvironmentPairingRevision
          )) || reservedNames.has(n)
        )
      })
      const destPath = joinPath(destinationDir, finalName)
      const destRelativePath = joinRuntimeRelativePath(destinationArgs.relativePath, finalName)
      for (const entry of source.entries) {
        uploadSignal?.throwIfAborted()
        const entryRelativePath = joinRuntimeRelativePath(destRelativePath, entry.relativePath)
        if (entry.kind === 'directory') {
          await callRuntimeFileImportMutation(
            importSession,
            'files.createDirNoClobber',
            withSshMutationExpectation(context, {
              worktree: toRuntimeWorktreeSelector(context.worktreeId),
              relativePath: entryRelativePath
            }),
            15_000
          )
          if (source.kind === 'directory' && entry.relativePath === '') {
            createdDirectoryImportRoot = entryRelativePath
          }
          continue
        }
        await uploadRuntimeFileWithoutClobber(
          importSession,
          context.worktreeId,
          entryRelativePath,
          {
            sourceRootPath: source.sourcePath,
            entryRelativePath: entry.relativePath,
            expected: {
              byteLength: entry.byteLength,
              inode: entry.inode,
              deviceId: entry.deviceId,
              modifiedAtMs: entry.modifiedAtMs
            }
          },
          context.expectedSshConnectionGeneration,
          context.expectedSshTargetId,
          context.expectedExecutionHostId ??
            (context.expectedSshTargetId
              ? `ssh:${encodeURIComponent(context.expectedSshTargetId)}`
              : 'local'),
          transfer &&
            uploadSignal && {
              signal: uploadSignal,
              onProgress: (sentBytes) => transfer.onProgress(index, finishedEntryBytes + sentBytes)
            }
        )
        finishedEntryBytes += entry.byteLength
        transfer?.onProgress(index, finishedEntryBytes)
      }
      // No await from here to onDone, so a cancel either lands above or finds the source done.
      uploadSignal?.throwIfAborted()
      reservedNames.add(finalName)
      results.push({
        sourcePath: source.sourcePath,
        status: 'imported',
        destPath,
        kind: source.kind,
        renamed: finalName !== source.name
      })
      transfer?.onDone(index, 'uploaded')
    } catch (error) {
      if (createdDirectoryImportRoot) {
        // Match local directory rollback: remove the no-clobber root after partial nested runtime upload failure.
        await callRuntimeFileImportMutation(
          importSession,
          'files.delete',
          withSshMutationExpectation(context, {
            worktree: toRuntimeWorktreeSelector(context.worktreeId),
            relativePath: createdDirectoryImportRoot,
            recursive: true
          }),
          15_000
        ).catch(() => {})
      }
      // Cancel all ends the whole import; cancelling one source leaves it out and goes on.
      if (transfer?.signal.aborted) {
        throw error
      }
      if (sourceSignal?.aborted) {
        continue
      }
      results.push({
        sourcePath: source.sourcePath,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      })
      transfer?.onDone(index, 'failed')
    }
  }

  // A Cancel that lands during the last commit still rejects the import.
  transfer?.signal.throwIfAborted()
  return { results }
}
