/**
 * A remote text save too large for one request: chunks go to a temp in the host's private staging
 * folder, and the commit writes the target in place under the host's disk precondition, as a
 * one-request save does. Pinned to one runtime connection, because the host ties a save to the
 * socket that began it.
 */
import {
  parseFileWriteResult,
  type FileWriteDiskPrecondition,
  type FileWriteResult
} from '../../../shared/file-write-disk-precondition'
import {
  STAGED_FILE_SAVE_CHUNK_BYTES,
  STAGED_FILE_SAVE_METHODS,
  STAGED_FILE_SAVE_RUNTIME_CAPABILITY
} from '../../../shared/staged-file-save'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { callRuntimeRpc } from './runtime-rpc-client'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import {
  callRuntimeFileMutationWithCapabilities,
  RuntimeConnectionChangedError
} from './runtime-file-mutation-rpc'
import { bytesToBase64 } from './runtime-paged-file-read'

const CHUNK_TIMEOUT_MS = 30_000
const COMMIT_TIMEOUT_MS = 60_000

type StagedSaveTarget = { kind: 'environment'; environmentId: string }

/** `params` is the one-request write's params: worktree, relative path and ownership fields. */
export async function writeRemoteFileStaged(
  target: StagedSaveTarget,
  params: Record<string, unknown>,
  content: string,
  precondition: FileWriteDiskPrecondition | undefined,
  tooLargeForHost: () => Error,
  beforeSend?: () => void
): Promise<FileWriteResult> {
  const bytes = new TextEncoder().encode(content)
  const pairingRevision = captureRuntimeEnvironmentRequestRevision(target.environmentId)
  const connectionGeneration = getRuntimeEnvironmentConnectionGeneration(target.environmentId)
  const { saveId } = await callRuntimeFileMutationWithCapabilities<{ saveId: string }>(
    target,
    STAGED_FILE_SAVE_METHODS.begin,
    async (capabilities) => {
      // An older host keeps today's refusal: it can't take more than one request's worth.
      if (!capabilities.includes(STAGED_FILE_SAVE_RUNTIME_CAPABILITY)) {
        throw tooLargeForHost()
      }
      return { params: { ...params, totalBytes: bytes.length } }
    },
    15_000,
    pairingRevision
  )
  const send = <TResult>(method: string, sendParams: unknown, timeoutMs = CHUNK_TIMEOUT_MS) =>
    callRuntimeRpc<TResult>(target, method, sendParams, {
      timeoutMs,
      expectedEnvironmentPairingRevision: pairingRevision,
      beforeSend: () => {
        // Another socket can't continue this save: the host ties it to the one that began it.
        if (
          getRuntimeEnvironmentConnectionGeneration(target.environmentId) !== connectionGeneration
        ) {
          throw new RuntimeConnectionChangedError()
        }
      }
    })
  try {
    for (let offset = 0; offset < bytes.length; offset += STAGED_FILE_SAVE_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + STAGED_FILE_SAVE_CHUNK_BYTES)
      await send(STAGED_FILE_SAVE_METHODS.chunk, {
        saveId,
        offset,
        contentBase64: bytesToBase64(chunk)
      })
    }
    // The target changes only at the commit, so that is "the last moment before sending".
    beforeSend?.()
    return parseFileWriteResult(
      await send(
        STAGED_FILE_SAVE_METHODS.commit,
        { saveId, ...(precondition ? { diskPrecondition: precondition } : {}) },
        COMMIT_TIMEOUT_MS
      )
    )
  } catch (error) {
    // Best effort: an idle save is dropped by the host anyway.
    void send(STAGED_FILE_SAVE_METHODS.abort, { saveId }).catch(() => {})
    throw error
  }
}
