// An item's file link opens in Orca's editor, only inside its bot's folder: a bot wrote the path, so
// unlike a chat link a click is no grant to read elsewhere. Never a browser or another app, even for HTML.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { statUserOpenedPath } from '@/lib/files/access/user-opened-local-path'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { beginLinkOpenRequest } from '@/lib/links/link-open-request'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { isMissingRuntimePathError } from '@/runtime/files/metadata/runtime-file-metadata-client'
import { openLinkedFileInEditor } from '@/components/terminal-pane/links/files/terminal-file-link-editor-open'
import {
  isPathInsideWorktree,
  toWorktreeRelativePath
} from '../../../../../shared/terminal/links/terminal-links'
import { createNativeChatFileHref } from '../../../../../shared/native-chat/file-access/native-chat-href-routing'
import { resolveNativeChatFileLink } from '../../native-chat/links/actions/native-chat-file-link'
import type { NativeChatFileLinkContext } from '../../native-chat/links/actions/native-chat-file-link-context'
import {
  showFileLinkNotFoundToast,
  showFileLinkUnverifiableToast
} from '../../native-chat/links/actions/native-chat-file-link-toasts'

export type BotItemFileContext = {
  fileLinkContext: NativeChatFileLinkContext
  runtimeContext: RuntimeFileOperationArgs
}

function refuse(path: string): void {
  toast.error(
    translate('bots.items.link.fileOutside', "{{path}} isn't in this bot's folder", { path })
  )
}

/** The path, resolved in the bot's folder; null when it leads outside it, by `..` or an absolute path. */
export function botItemFilePath(path: string, context: BotItemFileContext): string | null {
  const folder = context.fileLinkContext.worktreePath
  const target = resolveNativeChatFileLink(
    createNativeChatFileHref(path, 'literal'),
    context.fileLinkContext
  )
  return target && isPathInsideWorktree(target.absolutePath, folder) ? target.absolutePath : null
}

export async function openBotItemFile(path: string, context: BotItemFileContext): Promise<void> {
  const filePath = botItemFilePath(path, context)
  if (!filePath) {
    refuse(path)
    return
  }
  const isCurrent = beginLinkOpenRequest()
  let stat: Awaited<ReturnType<typeof statUserOpenedPath>>
  try {
    // The chat opener's own check: a symlink in the folder that resolves out of it escapes.
    stat = await statUserOpenedPath(context.runtimeContext, filePath)
  } catch (error) {
    if (isCurrent()) {
      if (isMissingRuntimePathError(error)) {
        showFileLinkNotFoundToast(path)
      } else {
        showFileLinkUnverifiableToast(path, error)
      }
    }
    return
  }
  if (!isCurrent()) {
    return
  }
  if (stat.escapesWorktree) {
    refuse(path)
    return
  }
  if (stat.isDirectory) {
    toast.error(translate('bots.items.link.fileIsFolder', '{{path}} is a folder', { path }))
    return
  }
  const { worktreeId, worktreePath } = context.fileLinkContext
  const runtimeEnvironmentId = runtimeTargetEnvironmentId(context.runtimeContext.target)
  activateAndRevealWorkspace(worktreeId, { providesInitialSurface: true })
  openLinkedFileInEditor(
    {
      filePath,
      relativePath: toWorktreeRelativePath(filePath, worktreePath) || filePath,
      worktreeId,
      runtimeEnvironmentId
    },
    null,
    { line: null, column: null },
    isCurrent
  )
}
