import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadResult,
  RuntimeNativeChatFileContext,
  RuntimeTerminalPathResolution
} from '../../../shared/runtime-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  RuntimeFileOperationArgs,
  RuntimeReadableFileContent
} from './runtime-file-client-types'
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

/**
 * Previews a host file a chat links outside every workspace: the host grants this client the
 * exact path, then serves it through that grant. A refusal or missing file never becomes a read
 * of this computer. Null when the read is not a chat's paired-host file.
 */
export function readChatLinkedRuntimeFilePreview(
  context: RuntimeFileOperationArgs,
  absolutePath: string
): Promise<RuntimeFilePreviewResult> | null {
  const { target, worktreeId, nativeChatContext } = context
  if (target.kind !== 'environment' || !worktreeId || !nativeChatContext) {
    return null
  }
  return readThroughChatGrant(target, toRuntimeWorktreeSelector(worktreeId), absolutePath, {
    nativeChatContext
  })
}

async function readThroughChatGrant(
  target: RuntimeClientTarget & { kind: 'environment' },
  worktree: string,
  absolutePath: string,
  { nativeChatContext }: { nativeChatContext: RuntimeNativeChatFileContext }
): Promise<RuntimeFilePreviewResult> {
  const resolved = await callRuntimeRpc<RuntimeTerminalPathResolution>(
    target,
    'files.resolveTerminalPath',
    { worktree, pathText: absolutePath, nativeChatContext },
    { timeoutMs: 15_000 }
  )
  const openTarget = resolved.openTarget
  if (openTarget?.kind !== 'absolute-file') {
    throw new Error(`File not found on its host: ${absolutePath}`)
  }
  return callRuntimeRpc<RuntimeFilePreviewResult>(
    target,
    'files.readTerminalArtifactPreview',
    { worktree, grantId: openTarget.grantId, absolutePath: openTarget.absolutePath },
    { timeoutMs: 15_000 }
  )
}
