import { useCallback, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import type {
  CommentMarkdownFilePathSpans,
  CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { isFilePathCodeSpan } from '@/lib/file-path-code-span'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeTerminalPathResolution } from '../../../../shared/runtime-types'
import { resolveNativeChatFileLink, type NativeChatFileLinkContext } from './native-chat-file-link'

let latestNativeChatFileOpenRequestId = 0

// Why: chat text is agent-authored and can carry injected content, so a click
// must not reach openDetectedFilePath's ambient self-grant
// (src/main/ipc/filesystem-auth.ts authorizes any path it is handed). Confining
// chat opens to the worktree keeps a crafted message from opening ~/.ssh/id_rsa.
async function openResolvedWorktreeFileLink(
  absolutePath: string,
  line: number | null,
  column: number | null,
  context: NativeChatFileLinkContext,
  isCurrent: () => boolean
): Promise<boolean> {
  const resolved = await callRuntimeRpc<RuntimeTerminalPathResolution>(
    context.runtimeEnvironmentId
      ? { kind: 'environment', environmentId: context.runtimeEnvironmentId }
      : { kind: 'local' },
    'files.resolveTerminalPath',
    {
      worktree: `id:${context.worktreeId}`,
      pathText: absolutePath
    },
    { timeoutMs: 10_000 }
  )
  if (
    !isCurrent() ||
    !resolved.exists ||
    resolved.isDirectory ||
    resolved.openTarget?.kind !== 'worktree-file'
  ) {
    return false
  }
  openDetectedFilePath(resolved.openTarget.absolutePath, line, column, {
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    runtimeEnvironmentId: context.runtimeEnvironmentId,
    openWithSystemDefault: false,
    allowExternalPaths: false,
    openHtmlInBrowser: false
  })
  return true
}

function claimWorktreeFileLink(
  href: string | undefined,
  context: NativeChatFileLinkContext,
  options: { reportUnclaimed: boolean; isCurrent: () => boolean }
): boolean {
  const target = resolveNativeChatFileLink(href, context)
  if (!target) {
    if (options.reportUnclaimed) {
      toast.error(
        translate('components.native-chat.fileLinkUnresolved', 'Could not resolve that file path')
      )
    }
    return false
  }
  void openResolvedWorktreeFileLink(
    target.absolutePath,
    target.line,
    target.column,
    context,
    options.isCurrent
  )
    .then((opened) => {
      if (!opened && options.isCurrent()) {
        toast.error(
          translate('components.native-chat.fileLinkUnresolved', 'Could not resolve that file path')
        )
      }
    })
    .catch(() => {
      if (options.isCurrent()) {
        toast.error(
          translate('components.native-chat.fileLinkUnresolved', 'Could not resolve that file path')
        )
      }
    })
  return true
}

export function useNativeChatFileLinkClick(
  context: NativeChatFileLinkContext | null
): CommentMarkdownLinkClickHandler | undefined {
  useEffect(
    () => () => {
      latestNativeChatFileOpenRequestId += 1
    },
    [context]
  )
  const openFileLink = useCallback<CommentMarkdownLinkClickHandler>(
    (event, href) => {
      if (!context) {
        return
      }
      // A non-file href (http, mailto) resolves to null here and must fall
      // through to the anchor's default handling, so it reports no failure.
      const requestSeq = ++latestNativeChatFileOpenRequestId
      const claimed = claimWorktreeFileLink(href, context, {
        reportUnclaimed: false,
        isCurrent: () => latestNativeChatFileOpenRequestId === requestSeq
      })
      if (!claimed) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
    },
    [context]
  )
  return context ? openFileLink : undefined
}

export function useNativeChatFilePathSpans(
  context: NativeChatFileLinkContext | null
): CommentMarkdownFilePathSpans | undefined {
  useEffect(
    () => () => {
      latestNativeChatFileOpenRequestId += 1
    },
    [context]
  )
  const onOpen = useCallback<CommentMarkdownFilePathSpans['onOpen']>(
    (_event, pathText) => {
      if (!context) {
        return
      }
      // The span was already classified as a path, so a miss here is a real
      // failure worth surfacing rather than a silent no-op.
      const requestSeq = ++latestNativeChatFileOpenRequestId
      claimWorktreeFileLink(pathText, context, {
        reportUnclaimed: true,
        isCurrent: () => latestNativeChatFileOpenRequestId === requestSeq
      })
    },
    [context]
  )
  return useMemo(
    () => (context ? { isFilePath: isFilePathCodeSpan, onOpen } : undefined),
    [context, onOpen]
  )
}
