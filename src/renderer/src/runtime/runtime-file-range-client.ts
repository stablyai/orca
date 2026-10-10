import type { RuntimeFileReadChunkResult } from '../../../shared/runtime-types'
import { validateFileRangeRequest } from '../../../shared/file-range-read'
import type { RuntimeFileReadArgs } from './runtime-file-client-types'
import { assertExternalSshReadOwnership, canReadRelativeRuntimeFile } from './runtime-file-routing'
import { callRuntimeRpc, getActiveRuntimeTarget, RuntimeRpcCallError } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

function rangeReadTarget(args: RuntimeFileReadArgs) {
  assertExternalSshReadOwnership(args.settings, args.connectionId, args.expectedExternalSshTargetId)
  const target = getActiveRuntimeTarget(args.settings)
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

export type RuntimeFileSnapshot = { size: number; isDirectory: boolean; mtime: number }

export async function statRuntimeReadTarget(
  args: RuntimeFileReadArgs
): Promise<RuntimeFileSnapshot> {
  const remote = rangeReadTarget(args)
  if (!remote) {
    return window.api.fs.stat({
      filePath: args.filePath,
      connectionId: args.connectionId,
      access: args.access
    })
  }
  return callRuntimeRpc<RuntimeFileSnapshot>(
    remote.target,
    'files.stat',
    {
      worktree: remote.worktree,
      relativePath: remote.relativePath
    },
    { timeoutMs: 15_000 }
  )
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
    result = remote
      ? await callRuntimeRpc<RuntimeFileReadChunkResult>(
          remote.target,
          'files.readChunk',
          {
            worktree: remote.worktree,
            relativePath: remote.relativePath,
            offset,
            length
          },
          { timeoutMs: 60_000 }
        )
      : await window.api.fs.readFileChunk({
          filePath: args.filePath,
          connectionId: args.connectionId,
          access: args.access,
          offset,
          length
        })
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      throw new Error(
        'Large CSV previews require a newer Orca server. Update the server and retry.'
      )
    }
    throw error
  }
  const bytes = Uint8Array.from(atob(result.contentBase64), (character) => character.charCodeAt(0))
  if (bytes.length !== result.bytesRead || bytes.length > length || bytes.length === 0) {
    throw new Error('File changed or returned an invalid CSV chunk. Reload the preview.')
  }
  return bytes
}
