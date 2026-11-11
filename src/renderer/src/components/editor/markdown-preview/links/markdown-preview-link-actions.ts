import { afterPendingEntityTabs } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { toast } from 'sonner'
import { getConnectionIdForFile } from '@/lib/workspace/ownership/connection-context'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import {
  isLocalPathOpenBlocked,
  showLocalPathOpenBlockedToast
} from '@/lib/files/os-open/local-path-open-guard'
import { getLinkSourceLocalOpenOwner } from '@/lib/links/ownership/link-source-local-open-owner'
import { openHttpLink } from '@/lib/browser/navigation/http-link-routing'
import { translate } from '@/i18n/i18n'
import { requireRuntimeTargetForFileOwner } from '@/lib/files/access/file-owner-runtime-target'
import { statRuntimePath } from '@/runtime/files/metadata/runtime-file-metadata-client'
import { useAppStore } from '@/store/index'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import { relativePathInsideRoot } from '../../../../../../shared/cross-platform-path'
import { resolveMarkdownLinkTarget } from '../../markdown/link-routing/markdown-internal-links'
import { isExternalEditorFileDeepLink } from '../../../../../../shared/external-editor-uri-schemes'
import {
  fileUrlToAbsolutePath,
  resolveMarkdownPreviewHref,
  resolveMarkdownPreviewHttpOpenOptions
} from '../../markdown/link-routing/markdown-preview-links'
import { parseMarkdownPreviewLineTarget } from './markdown-preview-editor-reveal'
import {
  findMarkdownPreviewOpenedEditFileId,
  findMarkdownPreviewTargetWorktree
} from './markdown-preview-source-routing'
import {
  handleMarkdownPreviewSystemLinkClick,
  markdownPreviewLinkEditorOpener
} from './markdown-preview-system-link-action'
import { openMarkdownFileLinkWithSystemDefault } from '../../markdown/link-routing/markdown-file-link-system-open'
import type { MarkdownPreviewFoundation } from '../surface/use-markdown-preview-foundation'
import type { MarkdownPreviewViewport } from '../viewport/use-markdown-preview-viewport'

export type MarkdownPreviewLinkContext = Pick<
  MarkdownPreviewFoundation,
  | 'isMac'
  | 'sourceOwner'
  | 'sourceRoutingWorktreeId'
  | 'resolvedSourceRuntimeEnvironmentId'
  | 'worktreeRoot'
  | 'worktreesByRepo'
  | 'sourceWorktree'
  | 'activateMarkdownLink'
  | 'openFile'
  | 'openMarkdownPreview'
  | 'setMarkdownViewMode'
> &
  Pick<MarkdownPreviewViewport, 'scrollToAnchor'>

export async function handleMarkdownPreviewLinkClick({
  event,
  href,
  filePath,
  context
}: {
  event: React.MouseEvent<HTMLAnchorElement>
  href: string | undefined
  filePath: string
  context: MarkdownPreviewLinkContext
}): Promise<void> {
  // Why: an empty href (a stripped URL) would otherwise reload the Orca window.
  event.preventDefault()
  if (!href) {
    return
  }

  const {
    isMac,
    sourceOwner,
    sourceRoutingWorktreeId,
    resolvedSourceRuntimeEnvironmentId,
    worktreeRoot,
    worktreesByRepo,
    sourceWorktree,
    activateMarkdownLink,
    openFile,
    openMarkdownPreview,
    setMarkdownViewMode,
    scrollToAnchor
  } = context

  if (href.startsWith('#')) {
    void scrollToAnchor(href.slice(1))
    return
  }

  const target = resolveMarkdownPreviewHref(href, filePath)

  // Why: every click opens an editor link through the OS, so it skips the modifier routing.
  if (target && isExternalEditorFileDeepLink(target)) {
    if (sourceOwner.kind === 'unknown') {
      return
    }
    if (
      isLocalPathOpenBlocked(
        getLinkSourceLocalOpenOwner(useAppStore.getState(), sourceOwner, sourceRoutingWorktreeId)
      )
    ) {
      // Why: the link names a path on this computer, not on the document's remote host.
      showLocalPathOpenBlockedToast()
      return
    }
    try {
      await window.api.shell.openUrl(target.toString())
    } catch {
      toast.error(translate('auto.lib.workspace.browser.tab.open.urlFailed', 'Unable to open URL.'))
    }
    return
  }

  if (handleMarkdownPreviewSystemLinkClick({ event, href, filePath, context })) {
    return
  }

  if (!target) {
    return
  }

  if (target.protocol === 'http:' || target.protocol === 'https:') {
    openHttpLink(
      target.toString(),
      resolveMarkdownPreviewHttpOpenOptions(event, isMac, sourceRoutingWorktreeId, sourceOwner)
    )
    return
  }

  if (target.protocol !== 'file:') {
    return
  }

  const classified = resolveMarkdownLinkTarget(href, filePath, worktreeRoot)
  const classifiedFileTarget =
    classified?.kind === 'markdown' || classified?.kind === 'file' ? classified : null
  const absolutePath = classifiedFileTarget?.absolutePath ?? fileUrlToAbsolutePath(target)
  if (!absolutePath) {
    return
  }
  const lineTarget =
    classifiedFileTarget?.line !== undefined
      ? { line: classifiedFileTarget.line, column: classifiedFileTarget.column }
      : parseMarkdownPreviewLineTarget(target.hash)

  // Why: same-file anchors need no ownership resolution.
  if (absolutePath === filePath && target.hash && !lineTarget) {
    void scrollToAnchor(target.hash.slice(1))
    return
  }

  if (sourceOwner.kind === 'unknown') {
    return
  }

  const targetWorktree = findMarkdownPreviewTargetWorktree(
    worktreesByRepo,
    absolutePath,
    sourceWorktree,
    sourceOwner
  )
  if (!targetWorktree) {
    if (sourceRoutingWorktreeId && worktreeRoot) {
      void activateMarkdownLink(href, {
        sourceFilePath: filePath,
        worktreeId: sourceRoutingWorktreeId,
        worktreeRoot,
        runtimeEnvironmentId: resolvedSourceRuntimeEnvironmentId,
        sourceOwner
      })
      return
    }
    if (
      isLocalPathOpenBlocked(
        getLinkSourceLocalOpenOwner(useAppStore.getState(), sourceOwner, sourceRoutingWorktreeId)
      )
    ) {
      // Why: an unmatched remote path cannot fall back to the client OS.
      showLocalPathOpenBlockedToast()
      return
    }
    void openMarkdownFileLinkWithSystemDefault(
      target.toString(),
      markdownPreviewLinkEditorOpener(href, filePath, context)
    )
    return
  }

  const relativePath = relativePathInsideRoot(targetWorktree.path, absolutePath)
  if (relativePath === null) {
    return
  }
  const language = detectLanguage(absolutePath)
  const targetConnectionId = getConnectionIdForFile(targetWorktree.id, absolutePath)
  if (targetConnectionId === undefined) {
    return
  }
  try {
    const stats = await statRuntimePath(
      {
        target: requireRuntimeTargetForFileOwner(
          useAppStore.getState(),
          targetWorktree.id,
          resolvedSourceRuntimeEnvironmentId
        ),
        worktreeId: targetWorktree.id,
        worktreePath: targetWorktree.path,
        connectionId: targetConnectionId ?? undefined
      },
      absolutePath
    )
    if (stats.isDirectory) {
      toast.error(
        translate(
          'auto.components.editor.MarkdownPreview.759463a221',
          'Cannot open directory: {{value0}}',
          { value0: relativePath }
        )
      )
      return
    }
  } catch {
    toast.error(
      translate('auto.components.editor.MarkdownPreview.6c043947ae', 'File not found: {{value0}}', {
        value0: relativePath
      })
    )
    return
  }

  if (lineTarget) {
    openFile({
      filePath: absolutePath,
      relativePath,
      worktreeId: targetWorktree.id,
      runtimeEnvironmentId: resolvedSourceRuntimeEnvironmentId,
      language,
      mode: 'edit'
    })
    const openedState = useAppStore.getState()
    const targetFileId = findMarkdownPreviewOpenedEditFileId(
      openedState.openFiles,
      openedState.activeFileIdByWorktree,
      { filePath: absolutePath, worktreeId: targetWorktree.id }
    )
    if (language === 'markdown') {
      setMarkdownViewMode(targetFileId, 'source')
    }
    // Why: wait for the tab, then keep its reveal alive after Preview teardown.
    afterPendingEntityTabs(targetWorktree.id, targetFileId, () =>
      scheduleEditorLineReveal(
        useAppStore.getState,
        absolutePath,
        lineTarget.line,
        lineTarget.column,
        targetFileId
      )
    )
    return
  }

  if (language === 'markdown') {
    openMarkdownPreview(
      {
        filePath: absolutePath,
        relativePath,
        worktreeId: targetWorktree.id,
        runtimeEnvironmentId: resolvedSourceRuntimeEnvironmentId,
        language
      },
      { anchor: target.hash ? target.hash.slice(1) : null }
    )
    return
  }

  openFile({
    filePath: absolutePath,
    relativePath,
    worktreeId: targetWorktree.id,
    runtimeEnvironmentId: resolvedSourceRuntimeEnvironmentId,
    language,
    mode: 'edit'
  })
}
