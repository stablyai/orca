import { resolveHostWorkspaceFile } from '@/components/terminal-pane/terminal-host-workspace-file'
import { getRemoteFileArgs } from '@/runtime/runtime-file-routing'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { RuntimeFilePreviewResult } from '../../../../shared/runtime-types'
import { IMAGE_FILE_EXTENSIONS } from '../../../../shared/image-file-extensions'
import type { LocalFileAccess } from '../../../../shared/local-file-access'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-read-client'

export async function readLocalImagePreview(
  absolutePath: string,
  connectionId?: string | null,
  runtimeContext?: Omit<RuntimeFileOperationArgs, 'connectionId'> & {
    connectionId?: string | null
  },
  access?: LocalFileAccess
) {
  try {
    if (!runtimeContext) {
      return window.api.fs.readFile({
        filePath: absolutePath,
        connectionId: connectionId ?? undefined,
        ...(access && !connectionId ? { access } : {})
      })
    }
    const context = {
      ...runtimeContext,
      connectionId: runtimeContext.connectionId ?? connectionId ?? undefined
    }
    if (
      access?.kind === 'chat-image' &&
      context.nativeChatContext &&
      context.worktreeId &&
      context.target.kind === 'environment' &&
      !getRemoteFileArgs(context, absolutePath) &&
      IMAGE_FILE_EXTENSIONS.some((extension) => absolutePath.toLowerCase().endsWith(extension))
    ) {
      const resolved = await resolveHostWorkspaceFile(
        context,
        absolutePath,
        undefined,
        context.nativeChatContext
      )
      if (resolved?.kind === 'grant') {
        return callRuntimeRpc<RuntimeFilePreviewResult>(
          context.target,
          'files.readTerminalArtifactPreview',
          {
            worktree: toRuntimeWorktreeSelector(context.worktreeId),
            grantId: resolved.grantId,
            absolutePath: resolved.absolutePath
          },
          { timeoutMs: 15_000 }
        )
      }
      if (resolved?.kind === 'host' && !resolved.isDirectory) {
        return readRuntimeFilePreview(
          {
            ...context,
            worktreeId: resolved.worktreeId,
            worktreePath: resolved.worktreePath
          },
          resolved.absolutePath,
          access
        )
      }
      throw new Error('Chat image is unavailable on its host')
    }
    return readRuntimeFilePreview(context, absolutePath, access)
  } catch (error) {
    return Promise.reject(error)
  }
}
