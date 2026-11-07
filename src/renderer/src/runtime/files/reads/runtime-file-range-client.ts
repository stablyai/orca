import type { RuntimeFileReadChunkResult } from '../../../../../shared/runtime-file-contracts'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { validateFileRangeRequest } from '../../../../../shared/file-range-read'
import type { RuntimeFileReadArgs } from '../runtime-file-client-types'
import { assertExternalSshReadOwnership, canReadRelativeRuntimeFile } from '../runtime-file-routing'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '../../runtime-worktree-selector'
import { decodeBase64Bytes } from '@/lib/base64-bytes'
import {
  remoteFileRequest,
  type RemoteFileLocator
} from '../../../../../shared/remote-file-locator'

/** A file on a paired runtime, addressed the way its host's `files.*` methods expect. */
export type RuntimeRemoteFileAddress = {
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>
  worktree: string
  /** Pins a multi-call read to one pairing, so a re-pair cannot switch hosts mid-read. */
  expectedEnvironmentPairingRevision?: number
} & RemoteFileLocator

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
  const worktree = toRuntimeWorktreeSelector(args.worktreeId)
  // Why: a caller that pinned its pairing keeps every later call on that host.
  const pairing =
    args.expectedEnvironmentPairingRevision === undefined
      ? {}
      : { expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision }
  if (args.terminalArtifactGrantId) {
    return {
      target,
      worktree,
      grantId: args.terminalArtifactGrantId,
      absolutePath: args.filePath,
      ...pairing
    }
  }
  if (!canReadRelativeRuntimeFile(args.relativePath)) {
    throw new Error('Remote file is outside the owning runtime worktree')
  }
  return { target, worktree, relativePath: args.relativePath, ...pairing }
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
  const { method, params } = remoteFileRequest(remote.worktree, remote, 'stat')
  return callRuntimeRpc<RuntimeFileSnapshot>(remote.target, method, params, {
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision: remote.expectedEnvironmentPairingRevision
  })
}

export function readRemoteRuntimeFileChunk(
  remote: RuntimeRemoteFileAddress,
  offset: number,
  length: number
): Promise<RuntimeFileReadChunkResult> {
  const { method, params } = remoteFileRequest(remote.worktree, remote, 'readChunk')
  return callRuntimeRpc<RuntimeFileReadChunkResult>(
    remote.target,
    method,
    { ...params, offset, length },
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
