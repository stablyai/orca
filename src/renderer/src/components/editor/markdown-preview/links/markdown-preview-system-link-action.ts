import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  isLocalPathOpenBlocked,
  showLocalPathOpenBlockedToast
} from '@/lib/files/os-open/local-path-open-guard'
import { openHttpLink } from '@/lib/browser/navigation/http-link-routing'
import { getLinkSourceLocalOpenOwner } from '@/lib/links/ownership/link-source-local-open-owner'
import { useAppStore } from '@/store/index'
import {
  absolutePathToFileUri,
  resolveMarkdownLinkTarget
} from '../../markdown/link-routing/markdown-internal-links'
import { openMarkdownFileLinkWithSystemDefault } from '../../markdown/link-routing/markdown-file-link-system-open'
import {
  getMarkdownPreviewLinkTarget,
  isMarkdownPreviewSystemBrowserModifier,
  resolveMarkdownPreviewHttpOpenOptions
} from '../../markdown/link-routing/markdown-preview-links'
import type { MarkdownPreviewLinkContext } from './markdown-preview-link-actions'

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
  const { isMac, sourceOwner, sourceRoutingWorktreeId, worktreeRoot } = context
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
      getLinkSourceLocalOpenOwner(useAppStore.getState(), sourceOwner, sourceRoutingWorktreeId)
    )
  ) {
    // Why: the client OS cannot open server-local runtime or SSH paths.
    showLocalPathOpenBlockedToast()
    return true
  }
  const openInEditor = markdownPreviewLinkEditorOpener(href, filePath, context)
  const classified = resolveMarkdownLinkTarget(href, filePath, worktreeRoot)
  if (
    classified?.kind === 'markdown' ||
    (classified?.kind === 'file' && classified.line !== undefined)
  ) {
    const cleanUri = absolutePathToFileUri(classified.absolutePath)
    // A click is a user act: it may start the link's stopped WSL distro.
    void window.api.shell
      .pathExists(classified.absolutePath, { wakeWslDistro: true })
      .then((exists) => {
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
        void openMarkdownFileLinkWithSystemDefault(cleanUri, openInEditor)
      })
    return true
  }
  void openMarkdownFileLinkWithSystemDefault(parsed.toString(), openInEditor)
  return true
}

/** Opens the link in an Orca editor tab when main declines to launch it; null without a workspace. */
export function markdownPreviewLinkEditorOpener(
  href: string,
  filePath: string,
  context: Pick<
    MarkdownPreviewLinkContext,
    | 'sourceRoutingWorktreeId'
    | 'worktreeRoot'
    | 'sourceOwner'
    | 'resolvedSourceRuntimeEnvironmentId'
    | 'activateMarkdownLink'
  >
): (() => void) | null {
  const { sourceRoutingWorktreeId, worktreeRoot, sourceOwner } = context
  if (!sourceRoutingWorktreeId) {
    return null
  }
  return () =>
    void context.activateMarkdownLink(href, {
      sourceFilePath: filePath,
      worktreeId: sourceRoutingWorktreeId,
      worktreeRoot,
      runtimeEnvironmentId: context.resolvedSourceRuntimeEnvironmentId,
      sourceOwner
    })
}
