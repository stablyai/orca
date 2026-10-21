import type { PreloadApi } from '../../../preload/api-types'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { SshConnectionState, SshMutationExpectation } from '../../../shared/ssh-types'
import type { Worktree } from '../../../shared/worktree/types'
import { toRuntimeWorktreeSelector } from '../runtime/runtime-worktree-selector'
import type { RuntimeFileSnapshot } from '../runtime/runtime-file-range-client'
import { pagedTextFileResult, readFileInChunks } from '../runtime/runtime-paged-file-read'
import type { RuntimeFileReadChunkResult } from '../../../shared/runtime-types'
import {
  compareDiskWritePrecondition,
  diskConflictFromReadFailure,
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IF_UNCHANGED_METHOD,
  parseFileWriteResult,
  type FileWriteDiskConflict,
  type FileWriteDiskPrecondition,
  type FileWriteResult
} from '../../../shared/file-write-disk-precondition'

const SSH_OWNER_CHANGED_MESSAGE =
  "Couldn't verify the SSH connection. Reconnect the host and try again."

type WebFileMutationMethod = Pick<
  NonNullable<PreloadApi['fs']>,
  'writeFile' | 'createFile' | 'createDir' | 'rename' | 'copy' | 'deletePath'
>

type ResolvedWebRuntimeFile = {
  worktree: Pick<Worktree, 'id' | 'hostId'>
  relativePath: string
}

type WebFileMutationSession = {
  resolveFilePath: (filePath: string) => Promise<ResolvedWebRuntimeFile>
  /**
   * Resolves to the host's advertised capabilities. `pinConnection` sends the session's later
   * calls only over the connection that answered, for writes whose choice depends on that host.
   */
  assertMutationSupported: (options: { pinConnection: boolean }) => Promise<readonly string[]>
  callRuntimeResult: (method: string, params: unknown) => Promise<unknown>
  getSshState: (targetId: string) => Promise<SshConnectionState | null>
}

type WebFileMutationDependencies = {
  captureSession: () => WebFileMutationSession
}

type WebFileMutationProvenance = SshMutationExpectation & {
  expectedExecutionHostId: 'local' | `ssh:${string}`
}

async function captureWebFileMutationProvenance(
  file: ResolvedWebRuntimeFile,
  getSshState: WebFileMutationSession['getSshState']
): Promise<WebFileMutationProvenance> {
  const host = parseExecutionHostId(file.worktree.hostId)
  if (file.worktree.hostId !== undefined && !host) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  if (!host || host.kind === 'local' || host.kind === 'runtime') {
    return { expectedExecutionHostId: 'local' }
  }

  const state = await getSshState(host.targetId)
  if (state?.targetId !== host.targetId || state.connectionGeneration === undefined) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  return {
    expectedExecutionHostId: host.id,
    expectedSshTargetId: host.targetId,
    expectedSshConnectionGeneration: state.connectionGeneration
  }
}

function assertSameWorktree(
  source: ResolvedWebRuntimeFile,
  destination: ResolvedWebRuntimeFile
): void {
  if (source.worktree.id !== destination.worktree.id) {
    throw new Error('File operation cannot cross runtime worktrees')
  }
}

function parseFileSnapshot(value: unknown): RuntimeFileSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('size' in value && typeof value.size === 'number') ||
    !('isDirectory' in value && typeof value.isDirectory === 'boolean') ||
    !('mtime' in value && typeof value.mtime === 'number')
  ) {
    throw new Error('Remote file stat returned an invalid result')
  }
  const ctime = 'ctime' in value && typeof value.ctime === 'number' ? value.ctime : undefined
  return { size: value.size, isDirectory: value.isDirectory, mtime: value.mtime, ctime }
}

function parseFileChunk(value: unknown): RuntimeFileReadChunkResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('contentBase64' in value && typeof value.contentBase64 === 'string') ||
    !('bytesRead' in value && typeof value.bytesRead === 'number') ||
    !('eof' in value && typeof value.eof === 'boolean')
  ) {
    throw new Error('Remote file read returned an invalid chunk')
  }
  return { contentBase64: value.contentBase64, bytesRead: value.bytesRead, eof: value.eof }
}

/** A file past one reply's size cap, read in chunks the way the desktop client pages it. */
async function readWholeTextFile(
  session: WebFileMutationSession,
  file: ResolvedWebRuntimeFile
): Promise<string | undefined> {
  const address = {
    worktree: toRuntimeWorktreeSelector(file.worktree.id),
    relativePath: file.relativePath
  }
  const paged = await readFileInChunks({
    stat: async () => parseFileSnapshot(await session.callRuntimeResult('files.stat', address)),
    readChunk: async (offset, length) =>
      parseFileChunk(
        await session.callRuntimeResult('files.readChunk', { ...address, offset, length })
      )
  })
  if (paged.kind !== 'ok') {
    return undefined
  }
  const text = pagedTextFileResult(paged.bytes)
  return text.isBinary ? undefined : text.content
}

/** Paired servers may predate the precondition; read through the same preview the editor loaded from, then compare. */
async function checkWebDiskPreconditionFromClient(
  session: WebFileMutationSession,
  file: ResolvedWebRuntimeFile,
  precondition: FileWriteDiskPrecondition
): Promise<FileWriteDiskConflict | null> {
  let preview: unknown
  try {
    preview = await session.callRuntimeResult('files.readPreview', {
      worktree: toRuntimeWorktreeSelector(file.worktree.id),
      relativePath: file.relativePath
    })
  } catch (error) {
    // Why: the preview stops at one reply; a file the editor grew past that by saving is paged.
    if (error instanceof Error && error.message === 'file_too_large') {
      // Why undefined on failure: a host that can't page it keeps the earlier answer, 'changed'.
      const text = await readWholeTextFile(session, file).catch(() => undefined)
      return compareDiskWritePrecondition(precondition, text)
    }
    return diskConflictFromReadFailure(precondition, error)
  }
  const text =
    typeof preview === 'object' &&
    preview !== null &&
    !('isBinary' in preview && preview.isBinary === true) &&
    'content' in preview &&
    typeof preview.content === 'string'
      ? preview.content
      : undefined
  return compareDiskWritePrecondition(precondition, text)
}

export function createWebFileMutationMethods(
  dependencies: WebFileMutationDependencies
): WebFileMutationMethod {
  const callMutation = async (
    session: WebFileMutationSession,
    method: string,
    file: ResolvedWebRuntimeFile,
    params: Record<string, unknown>,
    // Why: lets a capability-gated request branch on the same status the support check fetched.
    refine?: (
      capabilities: readonly string[]
    ) => Promise<{ method: string; params: Record<string, unknown> } | FileWriteResult>,
    pinConnection = false
  ): Promise<unknown> => {
    const capabilities = await session.assertMutationSupported({ pinConnection })
    const provenance = await captureWebFileMutationProvenance(file, session.getSshState)
    const refined = refine ? await refine(capabilities) : { method, params }
    if ('ok' in refined) {
      return refined
    }
    return session.callRuntimeResult(refined.method, {
      worktree: toRuntimeWorktreeSelector(file.worktree.id),
      ...refined.params,
      ...provenance
    })
  }

  return {
    writeFile: async ({ filePath, content, diskPrecondition }) => {
      const session = dependencies.captureSession()
      const file = await session.resolveFilePath(filePath)
      const params = { relativePath: file.relativePath, content }
      return parseFileWriteResult(
        await callMutation(
          session,
          'files.write',
          file,
          params,
          async (capabilities) => {
            if (!diskPrecondition) {
              return { method: 'files.write', params }
            }
            if (capabilities.includes(FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY)) {
              return {
                method: FILE_WRITE_IF_UNCHANGED_METHOD,
                params: { ...params, diskPrecondition }
              }
            }
            const diskConflict = await checkWebDiskPreconditionFromClient(
              session,
              file,
              diskPrecondition
            )
            return diskConflict ? { ok: false, diskConflict } : { method: 'files.write', params }
          },
          diskPrecondition !== undefined
        )
      )
    },
    createFile: async ({ filePath }) => {
      const session = dependencies.captureSession()
      const file = await session.resolveFilePath(filePath)
      await callMutation(session, 'files.createFile', file, { relativePath: file.relativePath })
    },
    createDir: async ({ dirPath }) => {
      const session = dependencies.captureSession()
      const file = await session.resolveFilePath(dirPath)
      await callMutation(session, 'files.createDir', file, { relativePath: file.relativePath })
    },
    rename: async ({ oldPath, newPath }) => {
      const session = dependencies.captureSession()
      const oldFile = await session.resolveFilePath(oldPath)
      const newFile = await session.resolveFilePath(newPath)
      assertSameWorktree(oldFile, newFile)
      await callMutation(session, 'files.rename', oldFile, {
        oldRelativePath: oldFile.relativePath,
        newRelativePath: newFile.relativePath
      })
    },
    copy: async ({ sourcePath, destinationPath }) => {
      const session = dependencies.captureSession()
      const source = await session.resolveFilePath(sourcePath)
      const destination = await session.resolveFilePath(destinationPath)
      assertSameWorktree(source, destination)
      await callMutation(session, 'files.copy', source, {
        sourceRelativePath: source.relativePath,
        destinationRelativePath: destination.relativePath
      })
    },
    deletePath: async ({ targetPath, recursive }) => {
      const session = dependencies.captureSession()
      const file = await session.resolveFilePath(targetPath)
      await callMutation(session, 'files.delete', file, {
        relativePath: file.relativePath,
        recursive
      })
    }
  }
}
