import {
  compareDiskWritePrecondition,
  diskConflictFromReadFailure,
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IF_UNCHANGED_METHOD,
  FILE_WRITE_OK,
  parseFileWriteResult,
  type FileWriteDiskConflict,
  type FileWriteDiskPrecondition,
  type FileWriteResult
} from '../../../shared/file-write-disk-precondition'
import {
  getDiskBaselineSignature,
  getWrittenContentDiskSignature
} from '../../../shared/disk-baseline-signature'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime-client-error-classification'
import {
  callRuntimeFileMutationWithCapabilities,
  isRuntimeConnectionChangedError
} from './runtime-file-mutation-rpc'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { readRuntimeFileContent } from './runtime-file-read-client'
import {
  captureRuntimeEnvironmentRequestRevision,
  getRuntimeEnvironmentRevision
} from './runtime-environment-revision'
import { getRelativePathInsideWorktree } from './runtime-file-routing'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'

/** `files.write` params; the guarded method adds `diskPrecondition`. */
export type RemoteFileWriteParams = {
  worktree: string
  relativePath: string
  content: string
  expectedExecutionHostId: 'local' | `ssh:${string}`
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
}

type RemoteFileContext = RuntimeFileOperationArgs & {
  target: RuntimeClientTarget & { kind: 'environment' }
}

function readRemoteFile(
  context: RemoteFileContext,
  filePath: string
): Promise<{ content: string; isBinary: boolean }> {
  return readRuntimeFileContent({
    target: context.target,
    filePath,
    relativePath: getRelativePathInsideWorktree(context.worktreePath, filePath) ?? undefined,
    worktreeId: context.worktreeId ?? undefined,
    connectionId: context.connectionId,
    expectedExternalSshTargetId: context.expectedExternalSshTargetId
  })
}

async function diskHoldsWrittenContent(
  context: RemoteFileContext,
  filePath: string,
  content: string,
  pairingRevision: number | undefined
): Promise<boolean> {
  // Why the save's pairing: a host the environment was re-paired to proves nothing about this write.
  const samePairing = (): boolean =>
    getRuntimeEnvironmentRevision(context.target.environmentId) === pairingRevision
  try {
    if (!samePairing()) {
      return false
    }
    const current = await readRemoteFile(context, filePath)
    return (
      samePairing() &&
      !current.isBinary &&
      getDiskBaselineSignature(current.content) === getWrittenContentDiskSignature(content)
    )
  } catch {
    return false
  }
}

/**
 * A guarded remote save. The host compares at write time when it serves `files.writeIfUnchanged`;
 * an older host gets a client-side compare before a plain write.
 */
export async function writeRemoteFileIfUnchanged(
  context: RemoteFileContext,
  filePath: string,
  content: string,
  params: RemoteFileWriteParams,
  precondition: FileWriteDiskPrecondition
): Promise<FileWriteResult> {
  // Why once per save: a retry may follow a reconnect, never a re-pair to another host.
  const pairingRevision = captureRuntimeEnvironmentRequestRevision(context.target.environmentId)
  const attempt = async (): Promise<FileWriteResult> =>
    parseFileWriteResult(
      await callRuntimeFileMutationWithCapabilities<unknown>(
        context.target,
        'files.write',
        async (capabilities) => {
          if (capabilities.includes(FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY)) {
            return {
              method: FILE_WRITE_IF_UNCHANGED_METHOD,
              params: { ...params, diskPrecondition: precondition }
            }
          }
          const diskConflict = await checkDiskPreconditionFromClient(
            context,
            filePath,
            precondition
          )
          return diskConflict ? { result: { ok: false, diskConflict } } : { params }
        },
        15_000,
        pairingRevision
      )
    )
  try {
    return await attempt()
  } catch (error) {
    if (
      isRuntimeConnectionChangedError(error) &&
      getRuntimeEnvironmentRevision(context.target.environmentId) === pairingRevision
    ) {
      // Why: nothing was sent; one retry re-probes the new connection's capabilities.
      return attempt()
    }
    // Why: a reply lost to the transport may follow a write that landed; keeping it avoids refusing the next save.
    if (
      isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error)) &&
      (await diskHoldsWrittenContent(context, filePath, content, pairingRevision))
    ) {
      return FILE_WRITE_OK
    }
    throw error
  }
}

/**
 * For a host that would strip the precondition: compare from here before the unguarded write.
 * A read failure that doesn't prove the disk state fails the save rather than writing unverified.
 */
async function checkDiskPreconditionFromClient(
  context: RemoteFileContext,
  filePath: string,
  precondition: FileWriteDiskPrecondition
): Promise<FileWriteDiskConflict | null> {
  let current: { content: string; isBinary: boolean }
  try {
    current = await readRemoteFile(context, filePath)
  } catch (error) {
    return diskConflictFromReadFailure(precondition, error)
  }
  return compareDiskWritePrecondition(precondition, current.isBinary ? undefined : current.content)
}
