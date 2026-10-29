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
  // Why: resolve the target group up-front so preview replacement is scoped to it (group B open must not evict group A's preview).
  const requestedGroupId =
    linkPlacement?.kind === 'group' ? linkPlacement.groupId : options?.targetGroupId
  const targetGroupId = resolveEditorOpenTargetGroupId(s, worktreeId, requestedGroupId) ?? undefined
  scratch.editorItemTargetGroupId = targetGroupId
  const activeResult =
    options?.selection === 'none' ? {} : buildEditorActiveResult(s, worktreeId, id)
  if (existing) {
    const updatedPreview = isPreview ? existing.isPreview : false
    const nextExternalSshTargetId = file.externalSshTargetId ?? existing.externalSshTargetId
    const refreshExternalSshProvenance = file.externalSshTargetId !== undefined
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
      existing.fileContentReloadNonce !== fileContentReloadNonce ||
      existing.readOnly !== nextReadOnly ||
      existing.liveTail !== nextLiveTail
    if (!needsExistingUpdate) {
      return activeResult
    }
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
              terminalArtifactGrantId: nextGrantId,
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
      const prevOrder = s.tabBarOrderByWorktree?.[worktreeId]
      const previewTabBarUpdate = prevOrder
        ? {
            tabBarOrderByWorktree: {
              ...s.tabBarOrderByWorktree,
              [worktreeId]: prevOrder.map((eid) => (eid === replacedPreview.id ? id : eid))
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
