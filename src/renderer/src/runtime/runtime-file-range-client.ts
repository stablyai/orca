import type { RuntimeFileReadChunkResult } from '../../../shared/runtime-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { validateFileRangeRequest } from '../../../shared/file-range-read'
import type { RuntimeFileReadArgs } from './runtime-file-client-types'
import { assertExternalSshReadOwnership, canReadRelativeRuntimeFile } from './runtime-file-routing'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { decodeBase64Bytes } from '@/lib/base64-bytes'

/** A file on a paired runtime, addressed the way its host's `files.*` methods expect. */
export type RuntimeRemoteFileAddress = {
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>
  worktree: string
  relativePath: string
  /** Pins a multi-call read to one pairing, so a re-pair cannot switch hosts mid-read. */
  expectedEnvironmentPairingRevision?: number
}

/** The paired-runtime address for a read, or null when this client reads the file itself. */
export function rangeReadTarget(args: RuntimeFileReadArgs): RuntimeRemoteFileAddress | null {
  assertExternalSshReadOwnership(args.target, args.connectionId, args.expectedExternalSshTargetId)
  const target = args.target
  if (target.kind !== 'environment') {
    return null
  }
  if (!args.worktreeId) {
    throw new Error('Remote file has no owning runtime worktree')
  }
  if (!canReadRelativeRuntimeFile(args.relativePath)) {
    throw new Error('Remote file is outside the owning runtime worktree')
  }
  return {
    target,
    worktree: toRuntimeWorktreeSelector(args.worktreeId),
    relativePath: args.relativePath
  }
}

export type RuntimeFileSnapshot = {
  size: number
  isDirectory: boolean
  mtime: number
  ctime?: number
}

export function statRemoteRuntimeFile(
  remote: RuntimeRemoteFileAddress
): Promise<RuntimeFileSnapshot> {
  return callRuntimeRpc<RuntimeFileSnapshot>(
    remote.target,
    'files.stat',
    { worktree: remote.worktree, relativePath: remote.relativePath },
    {
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: remote.expectedEnvironmentPairingRevision
    }
  )
}

export function readRemoteRuntimeFileChunk(
  remote: RuntimeRemoteFileAddress,
  offset: number,
  length: number
): Promise<RuntimeFileReadChunkResult> {
  return callRuntimeRpc<RuntimeFileReadChunkResult>(
    remote.target,
    'files.readChunk',
    { worktree: remote.worktree, relativePath: remote.relativePath, offset, length },
    {
      timeoutMs: 60_000,
      expectedEnvironmentPairingRevision: remote.expectedEnvironmentPairingRevision
    }
  )
}

export async function statRuntimeReadTarget(
  args: RuntimeFileReadArgs
): Promise<RuntimeFileSnapshot> {
  const remote = rangeReadTarget(args)
  if (!remote) {
    return window.api.fs.stat({
      filePath: args.filePath,
      connectionId: args.connectionId,
      access: args.access,
      ...(args.wakeWslDistro && !args.connectionId ? { wakeWslDistro: true } : {})
    })
  }
  return statRemoteRuntimeFile(remote)
}

/** One raw `readChunk` reply, from this client's own file system or the owning runtime. */
export function readRuntimeFileChunk(
  args: RuntimeFileReadArgs,
  remote: RuntimeRemoteFileAddress | null,
  offset: number,
  length: number
): Promise<RuntimeFileReadChunkResult> {
  return remote
    ? readRemoteRuntimeFileChunk(remote, offset, length)
    : window.api.fs.readFileChunk({
        filePath: args.filePath,
        connectionId: args.connectionId,
        access: args.access,
        offset,
        length,
        ...(args.wakeWslDistro && !args.connectionId ? { wakeWslDistro: true } : {})
      })
}

export async function readRuntimeFileRange(
  args: RuntimeFileReadArgs,
  offset: number,
  length: number
): Promise<Uint8Array<ArrayBuffer>> {
  validateFileRangeRequest(offset, length)
  const remote = rangeReadTarget(args)
  let result: RuntimeFileReadChunkResult
  try {
    result = await readRuntimeFileChunk(args, remote, offset, length)
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      throw new Error(
        'Large CSV previews require a newer Orca server. Update the server and retry.'
      )
    }
    throw error
  }
  const bytes = decodeBase64Bytes(result.contentBase64)
  if (bytes.length !== result.bytesRead || bytes.length > length || bytes.length === 0) {
    throw new Error('File changed or returned an invalid CSV chunk. Reload the preview.')
  }
  return bytes
}
