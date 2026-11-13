import { openDocumentInFloatingWorkspace } from '@/components/floating-terminal/open-document-in-floating-workspace'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { revealFloatingWorkspacePanel } from '@/components/floating-terminal/floating-workspace-panel-reveal'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import { useAppStore } from '@/store/index'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import '@/store/slices/editor/tabs/editor-open-target-group'
import { isLiveLinkOpenGroup as isLiveEditorOpenGroup } from '@/lib/links/placement/link-open-intent'
import { flashRevealedEditorView } from '@/components/tab-group/editor-reveal-flash'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type {
  EditorOpenLinkIntent,
  EditorOpenResult
} from '@/store/slices/editor/types/editor-open-link-intent'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

/** An explicit group request may only end in an editor in the scope it was captured from. */
export function isExplicitEditorScopeKept(
  intent: EditorOpenLinkIntent | null,
  worktreeId: string,
  executionHostId: ExecutionHostId,
  clientLocal: boolean
): boolean {
  if (!intent?.targetGroupId || intent.workspaceId !== worktreeId || clientLocal) {
    return false
  }
  return (
    (intent.hostId === null || executionHostId === intent.hostId) &&
    isLiveEditorOpenGroup(useAppStore.getState(), worktreeId, intent.targetGroupId)
  )
}

/** The returned view still exists where the open put it, showing the same document. */
function isOpenedEditorViewCurrent(worktreeId: string, opened: EditorOpenResult): boolean {
  return (useAppStore.getState().unifiedTabsByWorktree?.[worktreeId] ?? []).some(
    (tab) =>
      tab.id === opened.viewStateId &&
      tab.groupId === opened.groupId &&
      tab.entityId === opened.fileId
  )
}

/** Open beside the source, or in floating when floatingHostId is supplied, and reveal the line in that view. */
export function openLinkedFileInEditor(
  file: Omit<OpenFile, 'id' | 'isDirty' | 'language' | 'mode'>,
  intent: EditorOpenLinkIntent | null,
  position: { line: number | null; column: number | null },
  isCurrentRequest: () => boolean,
  floatingHostId?: ExecutionHostId
): EditorOpenResult | null {
  const placementWorkspaceId = floatingHostId ? FLOATING_TERMINAL_WORKTREE_ID : file.worktreeId
  const language = detectLanguage(file.filePath)
  const existingViews = useAppStore.getState().unifiedTabsByWorktree?.[placementWorkspaceId] ?? []
  // Why on shown: a layout-owner build draws a new view only with main's frame.
  const reveal = (shown: EditorOpenResult | null): void => {
    if (!shown) {
      return
    }
    // Why: a link to an already-active tab otherwise changes nothing on screen.
    if (
      isCurrentRequest() &&
      existingViews.some((tab) => tab.id === shown.viewStateId && tab.entityId === shown.fileId)
    ) {
      flashRevealedEditorView(shown.viewStateId)
    }
    if (position.line === null) {
      return
    }
    if (language === 'markdown') {
      // Why: rich Markdown has no line-based reveal consumer; line links must mount Monaco.
      useAppStore.getState().setMarkdownViewMode(shown.fileId, 'source')
    }
    // Reveal only in this view; other document views keep their cursors, and later clicks supersede this request.
    scheduleEditorLineReveal(
      useAppStore.getState,
      file.filePath,
      position.line,
      position.column ?? 1,
      shown.fileId,
      {
        viewStateId: shown.viewStateId,
        canApply: () => isCurrentRequest() && isOpenedEditorViewCurrent(placementWorkspaceId, shown)
      }
    )
  }
  if (floatingHostId) {
    let opened: EditorOpenResult | null = null
    const state = useAppStore.getState()
    revealFloatingWorkspacePanel(state)
    openDocumentInFloatingWorkspace(
      (document, options) => {
        opened = state.openFileForLink(
          document,
          { ...options, forceContentReload: true },
          null,
          reveal
        )
        return opened?.fileId ?? ''
      },
      file,
      { executionHostId: floatingHostId }
    )
    return opened
  }
  return useAppStore
    .getState()
    .openFileForLink(
      { ...file, language, mode: 'edit' },
      { forceContentReload: true },
      intent,
      reveal
    )
}
