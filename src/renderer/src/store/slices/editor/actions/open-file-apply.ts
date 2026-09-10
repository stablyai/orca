import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import { getRecentlyClosedTabPosition, pushRecentlyClosedTabKind } from '../../recently-closed-tabs'
import type { AppState } from '../../../types'
import {
  type ClosedEditorTabSnapshot,
  MAX_RECENT_CLOSED_EDITOR_TABS,
  type OpenFile
} from '../types/open-file'
import {
  canReuseLocalWslAlias,
  getReusableOpenFileModes,
  isSameEditorOwner,
  matchesEditorMode,
  resolveEditorFileIdForOwner,
  shouldRequestExistingFileContentReload
} from '../file-ids/editor-file-ids'
import {
  buildEditorActiveResult,
  resolveEditorOpenTargetGroupId
} from '../tabs/editor-open-target-group'
import {
  getReplaceablePreviewFileId,
  removeEditorStateForReplacedPreview
} from '../tabs/workspace-editor-item'

export type OpenFileApplyScratch = {
  editorItemFileId: string
  editorItemTargetGroupId: string | undefined
}

export function applyOpenFileToState(
  s: AppState,
  file: Omit<OpenFile, 'id' | 'isDirty'>,
  options:
    | {
        preview?: boolean
        targetGroupId?: string
        recordReplacedPreview?: boolean
        suppressActiveRuntimeFallback?: boolean
        forceContentReload?: boolean
        focusEditor?: boolean
        reopenId?: string
      }
    | undefined,
  scratch: OpenFileApplyScratch
): Partial<AppState> | AppState {
  const worktreeId = file.worktreeId
  let operationProvenance = file.operationProvenance
  if (!operationProvenance && file.mode === 'edit' && file.readOnly !== true) {
    try {
      operationProvenance = captureEditorFileOperationProvenance(
        s,
        worktreeId,
        options?.suppressActiveRuntimeFallback ? null : file.runtimeEnvironmentId,
        options?.suppressActiveRuntimeFallback === true || file.runtimeEnvironmentId !== undefined
      )
    } catch (error) {
      toast.error(extractIpcErrorMessage(error, 'Failed to resolve file owner.'))
      // Why: mirrored tabs can arrive before their graph row; allow convergence while mutation paths still fail closed without provenance.
    }
  }
  const runtimeEnvironmentId = operationProvenance
    ? operationProvenance.generation.route.runtimeEnvironmentId
    : file.runtimeEnvironmentId === null
      ? null
      : (file.runtimeEnvironmentId ??
        (options?.suppressActiveRuntimeFallback
          ? null
          : (s.settings?.activeRuntimeEnvironmentId?.trim() ?? undefined)))
  const reusableOpenFileModes = getReusableOpenFileModes(file.mode)
  const existing = s.openFiles.find(
    (f) =>
      matchesEditorMode(f, reusableOpenFileModes) &&
      isSameEditorOwner(f, worktreeId, runtimeEnvironmentId) &&
      (f.filePath === file.filePath || canReuseLocalWslAlias(s, f, file, runtimeEnvironmentId))
  )
  // Why: a snapshot's reopenId can be a stale shape — the same path is bare in whichever worktree opened it first and namespaced elsewhere — so honoring it while this owner's tab is already open would strand activeFileId and the unified tab on an id no OpenFile has.
  const id = existing
    ? existing.id
    : options?.reopenId && !s.openFiles.some((candidate) => candidate.id === options.reopenId)
      ? options.reopenId
      : resolveEditorFileIdForOwner(
          s,
          file.filePath,
          worktreeId,
          runtimeEnvironmentId,
          reusableOpenFileModes
        )
  scratch.editorItemFileId = id
  const isPreview = options?.preview ?? false
  const recordReplacedPreview = options?.recordReplacedPreview ?? false
  // Why: resolve the target group up-front so preview replacement is scoped to it (group B open must not evict group A's preview).
  const targetGroupId =
    resolveEditorOpenTargetGroupId(s, worktreeId, options?.targetGroupId) ?? undefined
  scratch.editorItemTargetGroupId = targetGroupId
  const activeResult = buildEditorActiveResult(s, worktreeId, id)
  if (existing) {
    // If opening as non-preview, also pin the existing tab
    const updatedPreview = isPreview ? existing.isPreview : false
    const nextExternalSshTargetId = file.externalSshTargetId ?? existing.externalSshTargetId
    const refreshExternalSshProvenance = file.externalSshTargetId !== undefined
    const fileContentReloadNonce = shouldRequestExistingFileContentReload(
      existing,
      file.mode,
      options
    )
      ? (existing.fileContentReloadNonce ?? 0) + 1
      : existing.fileContentReloadNonce
    const needsExistingUpdate =
      existing.mode !== file.mode ||
      existing.diffSource !== file.diffSource ||
      existing.branchCompare?.compareVersion !== file.branchCompare?.compareVersion ||
      existing.commitCompare?.compareVersion !== file.commitCompare?.compareVersion ||
      existing.conflict?.kind !== file.conflict?.kind ||
      existing.conflict?.conflictKind !== file.conflict?.conflictKind ||
      existing.conflict?.conflictStatus !== file.conflict?.conflictStatus ||
      existing.conflictReview?.snapshotTimestamp !== file.conflictReview?.snapshotTimestamp ||
      existing.isPreview !== updatedPreview ||
      existing.language !== file.language ||
      existing.relativePath !== file.relativePath ||
      existing.worktreeId !== file.worktreeId ||
      existing.runtimeEnvironmentId !== runtimeEnvironmentId ||
      existing.externalSshTargetId !== nextExternalSshTargetId ||
      refreshExternalSshProvenance ||
      existing.fileContentReloadNonce !== fileContentReloadNonce
    if (!needsExistingUpdate) {
      return activeResult
    }
    // Why: `readOnly` is intentionally NOT in this override map — it's sticky, so `...f` preserves the tab's own read-only state.
    return {
      openFiles: s.openFiles.map((f) =>
        f.id === id
          ? {
              ...f,
              relativePath: file.relativePath,
              worktreeId: file.worktreeId,
              language: file.language,
              runtimeEnvironmentId,
              externalSshTargetId: nextExternalSshTargetId,
              operationProvenance: refreshExternalSshProvenance
                ? operationProvenance
                : f.operationProvenance,
              mode: file.mode,
              diffSource: file.diffSource,
              branchCompare: file.branchCompare,
              commitCompare: file.commitCompare,
              branchOldPath: file.branchOldPath,
              combinedAlternate: file.combinedAlternate,
              combinedAreaFilter: file.combinedAreaFilter,
              commitEntriesSnapshot: file.commitEntriesSnapshot,
              conflict: file.conflict,
              skippedConflicts: file.skippedConflicts,
              conflictReview: file.conflictReview,
              isPreview: updatedPreview,
              fileContentReloadNonce
            }
          : f
      ),
      ...activeResult
    }
  }

  // Why: scope preview replacement to worktreeId + targetGroupId so link clicks in group B don't evict group A's previews.
  let newFiles = s.openFiles
  if (isPreview) {
    const replaceablePreviewId = getReplaceablePreviewFileId(s, worktreeId, targetGroupId)
    const existingPreviewIdx = s.openFiles.findIndex((f) => f.id === replaceablePreviewId)
    if (existingPreviewIdx !== -1) {
      const replacedPreview = s.openFiles[existingPreviewIdx]
      // Why: reuse the shared eviction helper so per-file cursor/draft/visibility cleanup stays in one place.
      const {
        editorDrafts: nextEditorDrafts,
        editorCursorLine: nextEditorCursorLine,
        markdownViewMode: nextMarkdownViewMode,
        markdownRichModeSizeOverride: nextMarkdownRichModeSizeOverride,
        editorViewMode: nextEditorViewMode,
        markdownFrontmatterVisible: nextMarkdownFrontmatterVisible,
        markdownTableOfContentsVisible: nextMarkdownTableOfContentsVisible
      } = removeEditorStateForReplacedPreview(s, replacedPreview, id)
      // Replace in-place to preserve tab position
      newFiles = s.openFiles.map((f, i) =>
        i === existingPreviewIdx
          ? {
              ...file,
              id,
              isDirty: false,
              isPreview: true,
              runtimeEnvironmentId,
              operationProvenance
            }
          : f
      )
      // Swap the old preview ID for the new one in the stored tab bar order
      const prevOrder = s.tabBarOrderByWorktree?.[worktreeId]
      const previewTabBarUpdate = prevOrder
        ? {
            tabBarOrderByWorktree: {
              ...s.tabBarOrderByWorktree,
              [worktreeId]: prevOrder.map((eid) => (eid === replacedPreview.id ? id : eid))
            }
          }
        : {}
      // Why: push the evicted preview onto the recently-closed stack so Cmd/Ctrl+Shift+T can reopen it; gated to keep file-explorer clicks silent.
      let nextRecentlyClosed = s.recentlyClosedEditorTabsByWorktree
      let nextRecentlyClosedKinds = s.recentlyClosedTabKindsByWorktree
      if (recordReplacedPreview && replacedPreview.id !== id) {
        const {
          id: _rid,
          isDirty: _rdirty,
          mirroredFromRuntimeSession: _rmirrored,
          ...snap
        } = replacedPreview
        const stack = s.recentlyClosedEditorTabsByWorktree[worktreeId] ?? []
        const position = getRecentlyClosedTabPosition(s, worktreeId, replacedPreview.id)
        nextRecentlyClosed = {
          ...s.recentlyClosedEditorTabsByWorktree,
          [worktreeId]: [
            {
              ...(snap as ClosedEditorTabSnapshot),
              reopenId: replacedPreview.id,
              ...(position ? { position } : {})
            },
            ...stack
          ].slice(0, MAX_RECENT_CLOSED_EDITOR_TABS)
        }
        nextRecentlyClosedKinds = pushRecentlyClosedTabKind(
          s.recentlyClosedTabKindsByWorktree,
          worktreeId,
          'editor'
        )
      }
      return {
        openFiles: newFiles,
        editorDrafts: nextEditorDrafts,
        editorCursorLine: nextEditorCursorLine,
        markdownViewMode: nextMarkdownViewMode,
        markdownRichModeSizeOverride: nextMarkdownRichModeSizeOverride,
        editorViewMode: nextEditorViewMode,
        markdownFrontmatterVisible: nextMarkdownFrontmatterVisible,
        markdownTableOfContentsVisible: nextMarkdownTableOfContentsVisible,
        recentlyClosedEditorTabsByWorktree: nextRecentlyClosed,
        recentlyClosedTabKindsByWorktree: nextRecentlyClosedKinds,
        ...previewTabBarUpdate,
        ...activeResult
      }
    }
  }

  // Why: append to the persisted tab bar order, else TabBar's reconcileOrder falls back to type-grouped ordering (terminals first).
  const tabBarUpdate: Record<string, unknown> = {}
  if (s.tabBarOrderByWorktree) {
    const currentOrder = s.tabBarOrderByWorktree[worktreeId] ?? []
    const terminalIds = (s.tabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
    const editorFileIds = s.openFiles.filter((f) => f.worktreeId === worktreeId).map((f) => f.id)
    const browserIds = (s.browserTabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
    const allExisting = new Set([...terminalIds, ...editorFileIds, ...browserIds])
    const base = currentOrder.filter((eid) => allExisting.has(eid))
    const inBase = new Set(base)
    for (const eid of [...terminalIds, ...editorFileIds, ...browserIds]) {
      if (!inBase.has(eid)) {
        base.push(eid)
        inBase.add(eid)
      }
    }
    base.push(id)
    tabBarUpdate.tabBarOrderByWorktree = { ...s.tabBarOrderByWorktree, [worktreeId]: base }
  }

  return {
    openFiles: [
      ...newFiles,
      {
        ...file,
        id,
        isDirty: false,
        isPreview: isPreview || undefined,
        runtimeEnvironmentId,
        operationProvenance
      }
    ],
    ...tabBarUpdate,
    ...activeResult
  }
}
