import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { joinPath, normalizeRelativePath } from '@/lib/path'
import type { StagedRuntimeUploadFileIdentity } from '../../../shared/runtime-upload-staging-contract'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import {
  callRuntimeFileImportMutation,
  type RuntimeFileImportSession
} from './runtime-file-mutation-rpc'
import {
  getRemoteFileArgs,
  joinRuntimeRelativePath,
  withSshMutationExpectation
} from './runtime-file-routing'
import { runtimePathExists } from './runtime-file-metadata-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

/** Locates a staged file on the client so main can stream it without the renderer reading it. */
export type RuntimeUploadSource = {
  sourceRootPath: string
  entryRelativePath: string
  /** What staging observed; main refuses the upload if the source no longer matches. */
  expected: StagedRuntimeUploadFileIdentity
}

/** Stream one staged file to a temp path, then commit it; the temp path is always cleaned up. */
export async function uploadRuntimeFileWithoutClobber(
  session: RuntimeFileImportSession,
  worktreeId: string,
  relativePath: string,
  source: RuntimeUploadSource,
  expectedSshConnectionGeneration?: number,
  expectedSshTargetId?: string,
  expectedExecutionHostId?: 'local' | `ssh:${string}`,
  uploadId?: string
): Promise<void> {
  const tempRelativePath = makeRuntimeUploadTempPath(relativePath)
  try {
    session.assertCurrent()
    // Why: main owns the file handle and the runtime socket, so it streams the
    // body in slices; the renderer never holds the whole file.
    try {
      await window.api.fs.uploadExternalFileToRuntime({
        environmentId: session.target.environmentId,
        sourceRootPath: source.sourceRootPath,
        entryRelativePath: source.entryRelativePath,
        expected: source.expected,
        worktree: toRuntimeWorktreeSelector(worktreeId),
        relativePath: tempRelativePath,
        uploadId,
        expectedSshTargetId,
        expectedSshConnectionGeneration,
        expectedExecutionHostId,
        expectedEnvironmentPairingRevision: session.expectedEnvironmentPairingRevision,
        expectedEnvironmentRuntimeId: session.expectedEnvironmentRuntimeId
      })
    } catch (error) {
      // Why: this surfaces in the import result as-is, and Electron wraps a
      // main-process throw in "Error invoking remote method '…'".
      throw new Error(extractIpcErrorMessage(error, 'Upload failed'))
    }
    await callRuntimeFileImportMutation(
      session,
      'files.commitUpload',
      {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        tempRelativePath,
        finalRelativePath: relativePath,
        expectedSshTargetId,
        expectedSshConnectionGeneration,
        expectedExecutionHostId
      },
      30_000
    )
  } finally {
    await callRuntimeFileImportMutation(
      session,
      'files.delete',
      {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        relativePath: tempRelativePath,
        recursive: false,
        expectedSshTargetId,
        expectedSshConnectionGeneration,
        expectedExecutionHostId
      },
      15_000
    ).catch(() => {})
  }
}

/** Hidden sibling of the destination, so a failed upload never leaves a plausible-looking file. */
function makeRuntimeUploadTempPath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath)
  const slashIndex = normalized.lastIndexOf('/')
  const dir = slashIndex === -1 ? '' : normalized.slice(0, slashIndex + 1)
  const leaf = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1)
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${dir}.${leaf}.orca-upload-${nonce}`
}

export async function ensureRuntimeDirectory(
  context: RuntimeFileOperationArgs,
  destinationDir: string,
  session: RuntimeFileImportSession
): Promise<void> {
  const destinationArgs = getRemoteFileArgs(context, destinationDir)
  if (!destinationArgs) {
    return
  }
  const parts = normalizeRelativePath(destinationArgs.relativePath)
    .split('/')
    .filter((part) => part.length > 0)
  let current = ''
  for (const part of parts) {
    current = joinRuntimeRelativePath(current, part)
    const absolutePath = joinPath(context.worktreePath ?? '', current)
    session.assertCurrent()
    if (
      await runtimePathExists(context, absolutePath, session.expectedEnvironmentPairingRevision)
    ) {
      continue
    }
    await callRuntimeFileImportMutation(
      session,
      'files.createDir',
      withSshMutationExpectation(context, {
        worktree: destinationArgs.worktreeSelector,
        relativePath: current
      }),
      15_000
    )
  }
}
