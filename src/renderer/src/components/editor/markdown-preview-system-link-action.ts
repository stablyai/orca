import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { openHttpLink } from '@/lib/http-link-routing'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { absolutePathToFileUri, resolveMarkdownLinkTarget } from './markdown-internal-links'
import type { MarkdownPreviewLinkContext } from './markdown-preview-link-actions'
import {
  getMarkdownPreviewLinkTarget,
  isMarkdownPreviewSystemBrowserModifier,
  resolveMarkdownPreviewHttpOpenOptions
} from './markdown-preview-links'

export function handleMarkdownPreviewSystemLinkClick({
  event,
  href,
  filePath,
  context
}: {
  event: React.MouseEvent<HTMLAnchorElement>
  href: string
  filePath: string
  context: MarkdownPreviewLinkContext
}): boolean {
  const {
    isMac,
    sourceOwner,
    sourceRoutingWorktreeId,
    sourceConnectionId,
    resolvedSourceRuntimeEnvironmentId,
    worktreeRoot
  } = context
  if (!isMarkdownPreviewSystemBrowserModifier(event, isMac)) {
    return false
  }
  if (sourceOwner.kind === 'unknown') {
    return true
  }
  const osTarget = getMarkdownPreviewLinkTarget(href, filePath)
  if (!osTarget) {
    return true
  }
  let parsed: URL
  try {
    parsed = new URL(osTarget)
  } catch {
    return true
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    openHttpLink(
      parsed.toString(),
      resolveMarkdownPreviewHttpOpenOptions(event, isMac, sourceRoutingWorktreeId, sourceOwner)
    )
    return true
  }
  if (parsed.protocol !== 'file:') {
    return true
  }
  if (
    isLocalPathOpenBlocked(
      settingsForRuntimeOwner(useAppStore.getState().settings, resolvedSourceRuntimeEnvironmentId),
      { connectionId: sourceConnectionId }
    )
  ) {
    // Why: the client OS cannot open server-local runtime or SSH paths.
    showLocalPathOpenBlockedToast()
    return true
  }
  const classified = resolveMarkdownLinkTarget(href, filePath, worktreeRoot)
  if (
    classified?.kind === 'markdown' ||
    (classified?.kind === 'file' && classified.line !== undefined)
  ) {
    const cleanUri = absolutePathToFileUri(classified.absolutePath)
    void window.api.shell.pathExists(classified.absolutePath).then((exists) => {
      if (!exists) {
        toast.error(
          translate(
            'auto.components.editor.MarkdownPreview.6c043947ae',
            'File not found: {{value0}}',
            { value0: classified.relativePath ?? classified.absolutePath }
          )
        )
        return
      }
      void window.api.shell.openFileUri(cleanUri)
    })
    return true
  }
  void window.api.shell.openFileUri(parsed.toString())
  return true
}
