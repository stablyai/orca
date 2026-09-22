import type { MarkdownDocument } from '../../../shared/filesystem-entry-types'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import { assertLocalFilesystemFallbackAllowed, getRemoteFileArgs } from './runtime-file-routing'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

export async function listRuntimeMarkdownDocuments(
  context: RuntimeFileOperationArgs,
  rootPath: string
): Promise<MarkdownDocument[]> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId) {
    return window.api.fs.listMarkdownDocuments({
      rootPath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<MarkdownDocument[]>(
    target,
    'files.listMarkdownDocuments',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
    { timeoutMs: 15_000 }
  )
}

export async function statRuntimePath(
  context: RuntimeFileOperationArgs,
  absolutePath: string
): Promise<{ size: number; isDirectory: boolean; mtime: number }> {
  const remoteArgs = getRemoteFileArgs(context, absolutePath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    return window.api.fs.stat({
      filePath: absolutePath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<{ size: number; isDirectory: boolean; mtime: number }>(
    remoteArgs.target,
    'files.stat',
    { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
    { timeoutMs: 15_000 }
  )
}

export function isMissingRuntimePathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    message.includes('enoent') || message.includes('not found') || message.includes('no such file')
  )
}

export async function runtimePathExists(
  context: RuntimeFileOperationArgs,
  absolutePath: string,
  expectedEnvironmentPairingRevision?: number
): Promise<boolean> {
  const remoteArgs = getRemoteFileArgs(context, absolutePath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    return window.api.fs.pathExists({
      filePath: absolutePath,
      connectionId: context.connectionId
    })
  }

  try {
    await callRuntimeRpc(
      remoteArgs.target,
      'files.stat',
      { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
      { timeoutMs: 15_000, expectedEnvironmentPairingRevision }
    )
    return true
  } catch (err) {
    if (isMissingRuntimePathError(err)) {
      return false
    }
    throw err
  }
}
