import type { RuntimeFilePreviewResult, RuntimeFileReadResult } from '../../../shared/runtime-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeReadableFileContent } from './runtime-file-client-types'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

/** Reads a host file outside every workspace through the grant its host issued for it. */
export async function readRuntimeTerminalArtifactContent(args: {
  target: RuntimeClientTarget & { kind: 'environment' }
  worktreeId: string
  absolutePath: string
  grantId: string
}): Promise<RuntimeReadableFileContent> {
  const params = {
    worktree: toRuntimeWorktreeSelector(args.worktreeId),
    grantId: args.grantId,
    absolutePath: args.absolutePath
  }
  let result: RuntimeFileReadResult
  try {
    result = await callRuntimeRpc<RuntimeFileReadResult>(
      args.target,
      'files.readTerminalArtifact',
      params,
      { timeoutMs: 15_000 }
    )
  } catch (err) {
    // Why: the host refuses binary artifacts with this exact typed error; images use the preview.
    if (err instanceof RuntimeRpcCallError && err.message === 'binary_file') {
      return callRuntimeRpc<RuntimeFilePreviewResult>(
        args.target,
        'files.readTerminalArtifactPreview',
        params,
        { timeoutMs: 15_000 }
      )
    }
    throw err
  }
  if (result.truncated) {
    throw new Error(`Remote file is too large to open in the editor (${result.byteLength} bytes)`)
  }
  return { content: result.content, isBinary: false }
}
