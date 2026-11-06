import { encodeBase64Bytes } from '@/lib/base64-bytes'
import { normalizeRelativePath } from '@/lib/path'
import {
  FILE_BYTES_SAVE_UPDATE_REQUIRED_MESSAGE,
  FILE_BYTES_WRITE_CHUNK_BYTES,
  FILE_REPLACE_WITH_UPLOAD_METHOD,
  FILE_REPLACE_WITH_UPLOAD_RUNTIME_CAPABILITY,
  type FileBytesWritePrecondition
} from '../../../shared/file-bytes-write'
import {
  parseFileWriteResult,
  type FileWriteResult
} from '../../../shared/file-write-disk-precondition'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import {
  callRuntimeFileMutation,
  callRuntimeFileMutationWithCapabilities
} from './runtime-file-mutation-rpc'
import { localAccess } from './runtime-file-read-client'
import {
  assertLocalFilesystemFallbackAllowed,
  getRemoteFileArgs,
  withSshMutationExpectation
} from './runtime-file-routing'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'

function saveTempPath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath)
  const slash = normalized.lastIndexOf('/')
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${normalized.slice(0, slash + 1)}.${normalized.slice(slash + 1)}.orca-save-${nonce}`
}

/**
 * Replaces a binary file atomically, refused when its bytes no longer hash to the precondition's.
 * A remote host gets the bytes in chunks beside the file, then swaps them in with one call; a
 * host too old to swap is refused before anything is written.
 */
export async function writeRuntimeFileBytes(
  context: RuntimeFileOperationArgs,
  filePath: string,
  bytes: Uint8Array,
  access: LocalFileAccess | undefined,
  precondition: FileBytesWritePrecondition,
  /** Runs at the last moment before the bytes replace the file; throwing aborts the write. */
  beforeSend?: () => void
): Promise<FileWriteResult> {
  const remoteArgs = getRemoteFileArgs(context, filePath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    const write = window.api.fs.writeFileBytes
    if (!write) {
      throw new Error(FILE_BYTES_SAVE_UPDATE_REQUIRED_MESSAGE)
    }
    beforeSend?.()
    return parseFileWriteResult(
      await write(
        withSshMutationExpectation(context, {
          filePath,
          bytes,
          connectionId: context.connectionId,
          ...localAccess(context.connectionId, access),
          diskPrecondition: precondition
        })
      )
    )
  }
  const { target } = remoteArgs
  const pairing = captureRuntimeEnvironmentRequestRevision(target.environmentId)
  const tempRelativePath = saveTempPath(remoteArgs.relativePath)
  const params = withSshMutationExpectation(context, { worktree: remoteArgs.worktreeSelector })
  const chunk = (offset: number) => ({
    ...params,
    relativePath: tempRelativePath,
    contentBase64: encodeBase64Bytes(bytes.subarray(offset, offset + FILE_BYTES_WRITE_CHUNK_BYTES)),
    append: offset > 0
  })
  try {
    await callRuntimeFileMutationWithCapabilities(
      target,
      'files.writeBase64Chunk',
      async (capabilities) => {
        if (!capabilities.includes(FILE_REPLACE_WITH_UPLOAD_RUNTIME_CAPABILITY)) {
          throw new Error(FILE_BYTES_SAVE_UPDATE_REQUIRED_MESSAGE)
        }
        return { params: chunk(0) }
      },
      30_000,
      pairing
    )
    for (
      let offset = FILE_BYTES_WRITE_CHUNK_BYTES;
      offset < bytes.length;
      offset += FILE_BYTES_WRITE_CHUNK_BYTES
    ) {
      await callRuntimeFileMutation(
        target,
        'files.writeBase64Chunk',
        chunk(offset),
        30_000,
        pairing
      )
    }
    return parseFileWriteResult(
      await callRuntimeFileMutation(
        target,
        FILE_REPLACE_WITH_UPLOAD_METHOD,
        {
          ...params,
          tempRelativePath,
          finalRelativePath: remoteArgs.relativePath,
          bytesPrecondition: precondition
        },
        30_000,
        pairing,
        beforeSend
      )
    )
  } catch (error) {
    // The host removes the temp file once it swaps; a failed upload leaves it here.
    await callRuntimeFileMutation(
      target,
      'files.delete',
      { ...params, relativePath: tempRelativePath, recursive: false },
      15_000,
      pairing
    ).catch(() => {})
    throw error
  }
}
