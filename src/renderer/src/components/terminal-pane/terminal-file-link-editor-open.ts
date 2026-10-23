import { detectLanguage } from '@/lib/language-detect'
import { findWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { useAppStore } from '@/store'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import { isLiveEditorOpenGroup } from '@/store/slices/editor/tabs/editor-open-target-group'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type {
  EditorOpenLinkIntent,
  EditorOpenResult
} from '@/store/slices/editor/types/editor-open-link-intent'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'

export function resolveTerminalFileEditorTarget(params: {
  filePath: string
  worktreeId: string
  worktreePath: string
  executionHostId: ExecutionHostId
  hostGrantId: string | null
  escapesWorktree: boolean
}): { worktreeId: string; executionHostId: ExecutionHostId; relativePath: string } {
  const store = useAppStore.getState()
  let { worktreeId, executionHostId } = params
  let relativePath = params.filePath
  if (params.worktreePath && isPathInsideWorktree(params.filePath, params.worktreePath)) {
    const maybeRelative = toWorktreeRelativePath(params.filePath, params.worktreePath)
    // Why: a link out of the project keeps its absolute path so it names the same file after restart.
    if (maybeRelative !== null && maybeRelative.length > 0 && !params.escapesWorktree) {
      relativePath = maybeRelative
    }
  } else if (
    params.hostGrantId === null &&
    !isFloatingWorkspaceId(worktreeId) &&
    store.openFiles.some(
      (openFile) => openFile.filePath === params.filePath && openFile.worktreeId !== worktreeId
    )
  ) {
    // Why: early resolution is only needed to avoid an existing sibling-tab collision.
    const siblingRoute = findWorkspaceFileRoute(store, executionHostId, params.filePath)
    if (siblingRoute) {
      worktreeId = siblingRoute.worktreeId
      executionHostId = siblingRoute.executionHostId
      relativePath = siblingRoute.relativePath
    }
  }
  return { worktreeId, executionHostId, relativePath }
}

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
  // Why on shown: a layout-owner build draws a new view only with main's frame.
  const reveal = (shown: EditorOpenResult | null): void => {
    if (!shown || position.line === null) {
      return
    }
    if (language === 'markdown') {
      // Why: rich Markdown has no line-based reveal consumer; line links must mount Monaco.
      useAppStore.getState().setMarkdownViewMode(shown.fileId, 'source')
    }
    // Why: another view of the same document keeps its cursor, and a newer click (even one
    // without a line) supersedes this reveal until the editor consumes it.
    scheduleEditorLineReveal(
      useAppStore.getState,
      file.filePath,
      position.line,
      position.column ?? 1,
      shown.fileId,
      {
        viewStateId: shown.viewStateId,
        canApply: () => isCurrentRequest() && isOpenedEditorViewCurrent(file.worktreeId, shown)
      }
    )
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
