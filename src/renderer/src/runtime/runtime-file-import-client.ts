import { basename, joinPath } from '@/lib/path'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import { runtimePathExists } from './runtime-file-metadata-client'
import {
  assertRuntimeFileMutationCapability,
  callRuntimeFileMutation,
  createRuntimeImportSessionGuard
} from './runtime-file-mutation-rpc'
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

type StagedRuntimeImportSource =
  | {
      sourcePath: string
      status: 'staged'
      name: string
      kind: 'file' | 'directory'
      entries: StagedRuntimeImportEntry[]
    }
  | {
      sourcePath: string
      status: 'skipped'
      reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
    }
  | { sourcePath: string; status: 'failed'; reason: string }

type StagedRuntimeImportEntry =
  | { relativePath: string; kind: 'directory' }
  | { relativePath: string; kind: 'file'; contentBase64: string }

type RuntimeImportResult =
  | {
      sourcePath: string
      status: 'imported'
      destPath: string
      kind: 'file' | 'directory'
      renamed: boolean
    }
  | {
      sourcePath: string
      status: 'skipped'
      reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
    }
  | {
      sourcePath: string
      status: 'failed'
      reason: string
    }

export async function importExternalPathsToRuntime(
  context: RuntimeFileOperationArgs,
  sourcePaths: string[],
  destinationDir: string,
  options?: { ensureDestinationDir?: boolean; assertCurrent?: () => void }
): Promise<{ results: RuntimeImportResult[] }> {
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
  const assertImportSessionCurrent = createRuntimeImportSessionGuard(
    target.environmentId,
    expectedEnvironmentPairingRevision,
    options?.assertCurrent
  )
  await assertRuntimeFileMutationCapability(target, expectedEnvironmentPairingRevision)
  assertImportSessionCurrent()
  const staged = await window.api.fs.stageExternalPathsForRuntimeUpload({ sourcePaths })
  assertImportSessionCurrent()
  const results: RuntimeImportResult[] = []
  const reservedNames = new Set<string>()

  await ensureRuntimeDirectory(
    context,
    destinationDir,
    assertImportSessionCurrent,
    expectedEnvironmentPairingRevision
  )

  for (const source of staged.sources as StagedRuntimeImportSource[]) {
    if (source.status !== 'staged') {
      results.push(source)
      continue
    }
    let createdDirectoryImportRoot: string | null = null
    try {
      const finalName = await deconflictRuntimeImportName(
        context,
        destinationDir,
        source.name,
        reservedNames,
        expectedEnvironmentPairingRevision
      )
      const destPath = joinPath(destinationDir, finalName)
      const destRelativePath = joinRuntimeRelativePath(destinationArgs.relativePath, finalName)
      for (const entry of source.entries) {
        const entryRelativePath = joinRuntimeRelativePath(destRelativePath, entry.relativePath)
        if (entry.kind === 'directory') {
          assertImportSessionCurrent()
          await callRuntimeFileMutation(
            target,
            'files.createDirNoClobber',
            withSshMutationExpectation(context, {
              worktree: toRuntimeWorktreeSelector(context.worktreeId),
              relativePath: entryRelativePath
            }),
            15_000,
            expectedEnvironmentPairingRevision
          )
          if (source.kind === 'directory' && entry.relativePath === '') {
            createdDirectoryImportRoot = entryRelativePath
          }
          continue
        }
        await uploadRuntimeFileWithoutClobber(
          target,
          context.worktreeId,
          entryRelativePath,
          entry.contentBase64,
          assertImportSessionCurrent,
          context.expectedSshConnectionGeneration,
          context.expectedSshTargetId,
          context.expectedExecutionHostId ??
            (context.expectedSshTargetId
              ? `ssh:${encodeURIComponent(context.expectedSshTargetId)}`
              : 'local'),
          expectedEnvironmentPairingRevision
        )
      }
      reservedNames.add(finalName)
      results.push({
        sourcePath: source.sourcePath,
        status: 'imported',
        destPath,
        kind: source.kind,
        renamed: finalName !== source.name
      })
    } catch (error) {
      if (createdDirectoryImportRoot) {
        // Why: match local directory imports by removing the no-clobber root
        // Orca created when a nested runtime upload fails halfway through.
        assertImportSessionCurrent()
        await callRuntimeFileMutation(
          target,
          'files.delete',
          withSshMutationExpectation(context, {
            worktree: toRuntimeWorktreeSelector(context.worktreeId),
            relativePath: createdDirectoryImportRoot,
            recursive: true
          }),
          15_000,
          expectedEnvironmentPairingRevision
        ).catch(() => {})
      }
      results.push({
        sourcePath: source.sourcePath,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { results }
}

async function deconflictRuntimeImportName(
  context: RuntimeFileOperationArgs,
  destinationDir: string,
  originalName: string,
  reservedNames: Set<string>,
  expectedEnvironmentPairingRevision?: number
): Promise<string> {
  if (
    !(await runtimePathExists(
      context,
      joinPath(destinationDir, originalName),
      expectedEnvironmentPairingRevision
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
  if (
    !(await runtimePathExists(
      context,
      joinPath(destinationDir, candidate),
      expectedEnvironmentPairingRevision
    )) &&
    !reservedNames.has(candidate)
  ) {
    return candidate
  }

  let counter = 2
  while (counter < 10000) {
    candidate = `${stem} copy ${counter}${ext}`
    if (
      !(await runtimePathExists(
        context,
        joinPath(destinationDir, candidate),
        expectedEnvironmentPairingRevision
      )) &&
      !reservedNames.has(candidate)
    ) {
      return candidate
    }
    counter += 1
  }
  throw new Error(`Could not generate a unique name for '${basename(originalName)}'`)
}
