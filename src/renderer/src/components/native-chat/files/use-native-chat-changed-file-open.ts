import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useWorkspaceFileBrowserActionPredicate } from '@/lib/browser/documents/file-preview'
import { changedFileOpenLabel } from '@/lib/files/open/changed-file-view'
import { isHtmlFilePath } from '@/components/terminal-pane/links/files/local-html-file-destinations'
import { createNativeChatFileHref } from '../../../../../shared/native-chat/file-access/native-chat-href-routing'
import { useNativeChatFileOpen } from '../links/actions/native-chat-link-click-context'
import type { NativeChatFileCardAction } from './NativeChatFileCard'

/** Opens a changed file's current version; null where this chat cannot open files. */
export function useNativeChatChangedFileOpen(path: string): NativeChatFileCardAction | null {
  const t = useTranslate()
  const opener = useNativeChatFileOpen()
  const href = createNativeChatFileHref(path, 'literal')
  const absolutePath = useMemo(() => opener?.resolvePath(href) ?? null, [href, opener])
  const page = absolutePath !== null && isHtmlFilePath(absolutePath)
  // Subscribes only for pages, so the label follows the same capability the click re-checks.
  const canShowPage = useWorkspaceFileBrowserActionPredicate(
    page && opener ? opener.worktreeId : null
  )
  if (!opener) {
    return null
  }
  const shown = page && canShowPage(absolutePath) ? 'orca-browser' : 'editor'
  const label = changedFileOpenLabel(shown, t)
  return {
    label,
    // A card can come from an old turn; the file on disk may have changed or gone since.
    tooltip: t('components.native-chat.tool.openCurrentFile', '{{action}} (current version)', {
      action: label
    }),
    glyph: shown,
    // The click-time capability wins over the rendered label if it changed in between.
    onOpen: () => opener.open(href, { destination: opener.destinationFor(href) })
  }
}
