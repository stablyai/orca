import { editorOpenTabBarOrder } from '../tabs/workspace-editor-files'
import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { captureEditorFileOperationProvenance } from '@/lib/editor/file-operations/editor-file-operation-provenance'
import { getRecentlyClosedTabPosition } from '../../tabs/recently-closed-tab-position'
import { pushRecentlyClosedTabKind } from '../../tabs/recently-closed-tabs'
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
  resolveEditorLinkOpenPlacement,
  resolveEditorOpenTargetGroupId
} from '../tabs/editor-open-target-group'
import type { OpenFileOptions } from '../types/editor-files-slice'
import type { EditorOpenLinkIntent } from '../types/editor-open-link-intent'
import { resolveEditorPreviewIntent } from '../tabs/editor-preview-tab-setting'
import {
  getReplaceablePreviewFileId,
  removeEditorStateForReplacedPreview
} from '../tabs/workspace-editor-item'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/non-secure-context-uuid'
import { emptySplitGroup, insertSplitGroup } from '../../tabs/tabs-group-actions'

export type OpenFileApplyScratch = {
  editorItemFileId: string
  editorItemTargetGroupId: string | undefined
  /** Resolved against the setting inside the reducer so the tab can't disagree with its OpenFile. */
  editorItemIsPreview: boolean
  /** Set when a link's explicit target failed revalidation; state was left untouched. */
  refused: boolean
}

export function applyOpenFileToState(
  s: AppState,
  file: Omit<OpenFile, 'id' | 'isDirty'>,
  options: OpenFileOptions | undefined,
  scratch: OpenFileApplyScratch,
  linkIntent: EditorOpenLinkIntent | null = null
): Partial<AppState> | AppState {
  const worktreeId = file.worktreeId
  const placementId = options?.placementWorkspaceId ?? worktreeId
  let operationProvenance = file.operationProvenance
  if (!operationProvenance && file.mode === 'edit' && file.readOnly !== true) {
    try {
      operationProvenance = captureEditorFileOperationProvenance(
        s,
        worktreeId,
        options?.suppressActiveRuntimeFallback ? null : file.runtimeEnvironmentId,
        options?.suppressActiveRuntimeFallback === true || file.runtimeEnvironmentId !== undefined,
        options?.executionHostId
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
  // Already-open owner tabs outrank stale reopenId shapes; bare/namespaced drift otherwise points selection at no OpenFile.
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
  const linkPlacement =
    linkIntent && resolveEditorLinkOpenPlacement(s, worktreeId, linkIntent, id, file.mode)
  if (linkPlacement?.kind === 'refused') {
    scratch.refused = true
    return s
  }
  scratch.editorItemFileId = id
  const isPreview = resolveEditorPreviewIntent(s, options?.preview)
  scratch.editorItemIsPreview = isPreview
  const recordReplacedPreview = options?.recordReplacedPreview ?? false
  const splitGroup =
    linkPlacement?.kind === 'split' ? emptySplitGroup(worktreeId, createBrowserUuid()) : undefined
  const splitState =
    splitGroup && linkPlacement?.kind === 'split'
      ? insertSplitGroup(s, worktreeId, linkPlacement.split, splitGroup)
      : undefined
  // Why: resolve the target group up-front so preview replacement is scoped to it (group B open must not evict group A's preview).
  const requestedGroupId =
    splitGroup?.id ??
    (linkPlacement?.kind === 'group' ? linkPlacement.groupId : options?.targetGroupId)
  const targetGroupId =
    resolveEditorOpenTargetGroupId(s, placementId, requestedGroupId) ?? undefined
  scratch.editorItemTargetGroupId = targetGroupId
  const activeResult =
    options?.selection === 'none' ? {} : buildEditorActiveResult(s, placementId, id)
  if (existing) {
    const updatedPreview = isPreview ? existing.isPreview : false
    const nextExternalSshTargetId = file.externalSshTargetId ?? existing.externalSshTargetId
    const refreshExternalSshProvenance = file.externalSshTargetId !== undefined
    const nextOperationProvenance = refreshExternalSshProvenance
      ? operationProvenance
      : (existing.operationProvenance ?? operationProvenance)
    // Why: a re-click mints a fresh grant; the old one may have expired.
    const nextGrantId = file.terminalArtifactGrantId ?? existing.terminalArtifactGrantId
    const fileContentReloadNonce = shouldRequestExistingFileContentReload(
      existing,
      file.mode,
      options
    )
      ? (existing.fileContentReloadNonce ?? 0) + 1
      : existing.fileContentReloadNonce
    // Normal open explicitly enables editing of a View Log; View Log must never downgrade an already writable tab.
    const nextReadOnly = existing.readOnly === true && file.readOnly === true ? true : undefined
    const nextLiveTail = file.liveTail === true && nextReadOnly === true ? true : undefined
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
      existing.terminalArtifactGrantId !== nextGrantId ||
      refreshExternalSshProvenance ||
      existing.operationProvenance !== nextOperationProvenance ||
      existing.fileContentReloadNonce !== fileContentReloadNonce ||
      existing.readOnly !== nextReadOnly ||
      existing.liveTail !== nextLiveTail
    if (!needsExistingUpdate) {
      return { ...splitState, ...activeResult }
    }
    return {
      ...splitState,
      openFiles: s.openFiles.map((f) =>
        f.id === id
          ? {
              ...f,
              relativePath: file.relativePath,
              worktreeId: file.worktreeId,
              language: file.language,
              runtimeEnvironmentId,
              externalSshTargetId: nextExternalSshTargetId,
              terminalArtifactGrantId: nextGrantId,
              operationProvenance: nextOperationProvenance,
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
              fileContentReloadNonce,
              readOnly: nextReadOnly,
              liveTail: nextLiveTail
            }
          : f
      ),
      ...activeResult
    }
  }

  // Why: scope preview replacement to worktreeId + targetGroupId so link clicks in group B don't evict group A's previews.
  let newFiles = s.openFiles
  if (isPreview) {
    const replaceablePreviewId = getReplaceablePreviewFileId(s, placementId, targetGroupId)
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
      const prevOrder = s.tabBarOrderByWorktree?.[placementId]
      const previewTabBarUpdate = prevOrder
        ? {
            tabBarOrderByWorktree: {
              ...s.tabBarOrderByWorktree,
              [placementId]: prevOrder.map((eid) => (eid === replacedPreview.id ? id : eid))
            }
          }
        : {}
      // Capture evicted previews for Cmd/Ctrl+Shift+T only when requested; explorer single-clicks stay silent.
      let nextRecentlyClosed = s.recentlyClosedEditorTabsByWorktree
      let nextRecentlyClosedKinds = s.recentlyClosedTabKindsByWorktree
      if (recordReplacedPreview && replacedPreview.id !== id) {
        const {
          id: _rid,
          isDirty: _rdirty,
          mirroredFromRuntimeSession: _rmirrored,
          ...snap
        } = replacedPreview
        const stack = s.recentlyClosedEditorTabsByWorktree[placementId] ?? []
        const position = getRecentlyClosedTabPosition(s, placementId, replacedPreview.id)
        nextRecentlyClosed = {
          ...s.recentlyClosedEditorTabsByWorktree,
          [placementId]: [
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
          placementId,
          'editor'
        )
      }
      return {
        ...splitState,
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

  return {
    ...splitState,
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
    ...editorOpenTabBarOrder(s, placementId, id),
    ...activeResult
  }
}
