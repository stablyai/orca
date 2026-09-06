import { toast } from 'sonner'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { detectLanguage } from '@/lib/language-detect'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { openHttpLink } from '@/lib/http-link-routing'
import { translate } from '@/i18n/i18n'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { statRuntimePath } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { resolveMarkdownLinkTarget } from './markdown-internal-links'
import {
  fileUrlToAbsolutePath,
  resolveMarkdownPreviewHref,
  resolveMarkdownPreviewHttpOpenOptions
} from './markdown-preview-links'
import {
  cancelMarkdownPreviewEditorRevealFrames,
  parseMarkdownPreviewLineTarget,
  requestMarkdownPreviewEditorRevealFrame
} from './markdown-preview-editor-reveal'
import {
  findMarkdownPreviewOpenedEditFileId,
  findMarkdownPreviewTargetWorktree
} from './markdown-preview-source-routing'
import { handleMarkdownPreviewSystemLinkClick } from './markdown-preview-system-link-action'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import type { MarkdownPreviewViewport } from './use-markdown-preview-viewport'

export type MarkdownPreviewLinkContext = Pick<
  MarkdownPreviewFoundation,
  | 'isMac'
  | 'sourceOwner'
  | 'sourceRoutingWorktreeId'
  | 'sourceConnectionId'
  | 'resolvedSourceRuntimeEnvironmentId'
  | 'worktreeRoot'
  | 'worktreesByRepo'
  | 'sourceWorktree'
  | 'activateMarkdownLink'
  | 'openFile'
  | 'openMarkdownPreview'
  | 'setMarkdownViewMode'
  | 'pendingEditorRevealFrameIdsRef'
  | 'setPendingEditorReveal'
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
  if (!href) {
    return
  }

  event.preventDefault()

  const {
    isMac,
    sourceOwner,
    sourceRoutingWorktreeId,
    sourceConnectionId,
    resolvedSourceRuntimeEnvironmentId,
    worktreeRoot,
    worktreesByRepo,
    sourceWorktree,
    activateMarkdownLink,
    openFile,
    openMarkdownPreview,
    setMarkdownViewMode,
    pendingEditorRevealFrameIdsRef,
    setPendingEditorReveal,
    scrollToAnchor
  } = context

  if (href.startsWith('#')) {
    void scrollToAnchor(href.slice(1))
    return
  }

  if (handleMarkdownPreviewSystemLinkClick({ event, href, filePath, context })) {
    return
  }

  const target = resolveMarkdownPreviewHref(href, filePath)
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
        settingsForRuntimeOwner(
          useAppStore.getState().settings,
          resolvedSourceRuntimeEnvironmentId
        ),
        { connectionId: sourceConnectionId }
      )
    ) {
      // Why: an unmatched remote path cannot fall back to the client OS.
      showLocalPathOpenBlockedToast()
      return
    }
    void window.api.shell.openFileUri(target.toString())
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
        settings: settingsForRuntimeOwner(
          useAppStore.getState().settings,
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
    cancelMarkdownPreviewEditorRevealFrames(pendingEditorRevealFrameIdsRef)
    setPendingEditorReveal(null)
    requestMarkdownPreviewEditorRevealFrame(pendingEditorRevealFrameIdsRef, () => {
      requestMarkdownPreviewEditorRevealFrame(pendingEditorRevealFrameIdsRef, () => {
        setPendingEditorReveal({
          filePath: absolutePath,
          fileId: targetFileId,
          line: lineTarget.line,
          column: lineTarget.column ?? 1,
          matchLength: 0
        })
      })
    })
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
