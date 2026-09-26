import { createBrowserUuid } from '@/lib/browser-uuid'
import { basename, joinPath } from '@/lib/path'
import type { ImportItemResult } from '../../../shared/filesystem-import-result-types'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import { runtimePathExists } from './runtime-file-metadata-client'
import {
  assertRuntimeFileMutationCapability,
  callRuntimeFileImportMutation,
  createRuntimeImportSessionGuard
} from './runtime-file-mutation-rpc'
import type { RuntimeFileImportSession } from './runtime-file-mutation-rpc'
import {
  getRemoteFileArgs,
  joinRuntimeRelativePath,
  withSshMutationExpectation
} from './runtime-file-routing'
import {
  ensureRuntimeDirectory,
  uploadRuntimeFileWithoutClobber
} from './runtime-file-upload-client'
import { getActiveRuntimeTarget } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  createRuntimeUploadProgressTracker,
  sumSourceUploadBytes,
  type RuntimeImportProgressHandlers,
  type RuntimeImportProgressRow,
  type RuntimeUploadProgressTracker
} from './runtime-upload-progress-tracker'

export async function importExternalPathsToRuntime(
  context: RuntimeFileOperationArgs,
  sourcePaths: string[],
  destinationDir: string,
  options?: {
    ensureDestinationDir?: boolean
    assertCurrent?: () => void
    progress?: RuntimeImportProgressHandlers
  }
): Promise<{ results: ImportItemResult[] }> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId || !context.worktreePath) {
    return window.api.fs.importExternalPaths(
      withSshMutationExpectation(context, {
        sourcePaths,
        destDir: destinationDir,
        connectionId: context.connectionId,
        ensureDir: options?.ensureDestinationDir
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
  const staged = await window.api.fs.stageExternalPathsForRuntimeUpload({ sourcePaths })
  importSession.assertCurrent()
  const handlers = options?.progress
  // One id per dropped source: it is both the progress key and the cancel handle,
  // so cancelling a row stops that source and leaves the rest of the drop running.
  const uploadIdsBySourcePath = new Map<string, string>()
  const trackers = new Map<string, RuntimeUploadProgressTracker>()
  if (handlers) {
    const rows: RuntimeImportProgressRow[] = []
    for (const source of staged.sources) {
      if (source.status !== 'staged') {
        continue
      }
      const rowUploadId = createBrowserUuid()
      uploadIdsBySourcePath.set(source.sourcePath, rowUploadId)
      const totalBytes = sumSourceUploadBytes(source)
      trackers.set(
        rowUploadId,
        createRuntimeUploadProgressTracker(totalBytes, ({ sentBytes }) =>
          handlers.onRowProgress(rowUploadId, sentBytes)
        )
      )
      rows.push({
        uploadId: rowUploadId,
        name: source.name,
        totalBytes,
        sourcePath: source.sourcePath
      })
    }
    handlers.onStart(rows)
  }
  const unsubscribeProgress = handlers
    ? window.api.fs.onUploadProgress((event) => {
        // Why: a concurrent drop in another pane shares this channel.
        trackers.get(event.uploadId)?.reportFileProgress(event.sentBytes)
      })
    : null
  const results: ImportItemResult[] = []
  const reservedNames = new Set<string>()

  try {
    await ensureRuntimeDirectory(context, destinationDir, importSession)

    for (const source of staged.sources) {
      if (source.status !== 'staged') {
        results.push(source)
        continue
      }
      let createdDirectoryImportRoot: string | null = null
      const sourceUploadId = uploadIdsBySourcePath.get(source.sourcePath)
      try {
        const finalName = await deconflictRuntimeImportName(
          context,
          destinationDir,
          source.name,
          reservedNames,
          importSession
        )
        const destPath = joinPath(destinationDir, finalName)
        const destRelativePath = joinRuntimeRelativePath(destinationArgs.relativePath, finalName)
        for (const entry of source.entries) {
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
          if (sourceUploadId) {
            trackers.get(sourceUploadId)?.beginFile()
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
            sourceUploadId
          )
          if (sourceUploadId) {
            trackers.get(sourceUploadId)?.completeFile(entry.byteLength)
          }
        }
        reservedNames.add(finalName)
        results.push({
          sourcePath: source.sourcePath,
          status: 'imported',
          destPath,
          kind: source.kind,
          renamed: finalName !== source.name
        })
        if (sourceUploadId) {
          handlers?.onRowSettled(sourceUploadId, 'done')
        }
      } catch (error) {
        if (createdDirectoryImportRoot) {
          // Why: match local directory imports by removing the no-clobber root
          // Orca created when a nested runtime upload fails halfway through.
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
        results.push({
          sourcePath: source.sourcePath,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error)
        })
        // Why: reported as failed even for a cancel — the store keeps the row's
        // already-set 'cancelled' state, so the user's own action is not relabelled.
        if (sourceUploadId) {
          handlers?.onRowSettled(sourceUploadId, 'failed')
        }
      }
    }

    return { results }
  } finally {
    unsubscribeProgress?.()
    for (const releasedId of uploadIdsBySourcePath.values()) {
      void window.api.fs.releaseRuntimeUpload({ uploadId: releasedId }).catch(() => {})
    }
    handlers?.onFinish()
  }
}

async function deconflictRuntimeImportName(
  context: RuntimeFileOperationArgs,
  destinationDir: string,
  originalName: string,
  reservedNames: Set<string>,
  session: RuntimeFileImportSession
): Promise<string> {
  session.assertCurrent()
  if (
    !(await runtimePathExists(
      context,
      joinPath(destinationDir, originalName),
      session.expectedEnvironmentPairingRevision
    )) &&
    !reservedNames.has(originalName)
  ) {
    return originalName
  }

  const dotIndex = originalName.lastIndexOf('.')
  const hasMeaningfulExt = dotIndex > 0
  const stem = hasMeaningfulExt ? originalName.slice(0, dotIndex) : originalName
  const ext = hasMeaningfulExt ? originalName.slice(dotIndex) : ''
  let candidate = `${stem} copy${ext}`
  session.assertCurrent()
  if (
    !(await runtimePathExists(
      context,
      joinPath(destinationDir, candidate),
      session.expectedEnvironmentPairingRevision
    )) &&
    !reservedNames.has(candidate)
  ) {
    return candidate
  }

  let counter = 2
  while (counter < 10000) {
    candidate = `${stem} copy ${counter}${ext}`
    session.assertCurrent()
    if (
      !(await runtimePathExists(
        context,
        joinPath(destinationDir, candidate),
        session.expectedEnvironmentPairingRevision
      )) &&
      !reservedNames.has(candidate)
    ) {
      return candidate
    }
    counter += 1
  }
  throw new Error(`Could not generate a unique name for '${basename(originalName)}'`)
}
