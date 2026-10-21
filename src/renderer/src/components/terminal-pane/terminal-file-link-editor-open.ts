import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import { isLiveEditorOpenGroup } from '@/store/slices/editor/tabs/editor-open-target-group'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type {
  EditorOpenLinkIntent,
  EditorOpenResult
} from '@/store/slices/editor/types/editor-open-link-intent'
import type { ExecutionHostId } from '../../../../shared/execution-host'

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

/** Opens a resolved link target beside its source, then reveals its line in exactly that view. */
export function openLinkedFileInEditor(
  file: Omit<OpenFile, 'id' | 'isDirty' | 'language' | 'mode'>,
  intent: EditorOpenLinkIntent | null,
  position: { line: number | null; column: number | null },
  isCurrentRequest: () => boolean
): EditorOpenResult | null {
  const language = detectLanguage(file.filePath)
  const opened = useAppStore
    .getState()
    .openFileForLink({ ...file, language, mode: 'edit' }, { forceContentReload: true }, intent)
  if (!opened || position.line === null) {
    return opened
  }
  if (language === 'markdown') {
    // Why: rich Markdown has no line-based reveal consumer; line links must mount Monaco.
    useAppStore.getState().setMarkdownViewMode(opened.fileId, 'source')
  }
  // Why: another view of the same document keeps its cursor, and a newer click (even one
  // without a line) supersedes this reveal until the editor consumes it.
  scheduleEditorLineReveal(
    useAppStore.getState,
    file.filePath,
    position.line,
    position.column ?? 1,
    opened.fileId,
    {
      viewStateId: opened.viewStateId,
      canApply: () => isCurrentRequest() && isOpenedEditorViewCurrent(file.worktreeId, opened)
    }
  )
  return opened
}
