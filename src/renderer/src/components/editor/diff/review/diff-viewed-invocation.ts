import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffContent } from '../../editor-panel-content-types'
import type { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { acquireEditorFileOperation } from '@/lib/editor/file-operations/editor-file-operation-owner'
import {
  diffReviewKey,
  diffReviewOwnerKey,
  getReviewedDiffs,
  reviewEntrySignature,
  setDiffReviewed,
  type ReviewedDiff
} from '@/lib/editor/diff-reviewed-files'
import {
  diffReviewListKey,
  getDiffReviewList,
  nextDiffReviewEntry
} from '@/lib/editor/diff-review-navigation'
import {
  statRuntimePath,
  isMissingRuntimePathError
} from '@/runtime/files/metadata/runtime-file-metadata-client'
import {
  editorViewTab,
  editorViewPlacement
} from '@/store/slices/editor/tabs/editor-view-placement'
import { buildUncommittedReviewEntries } from './uncommitted-review-entries'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import {
  buildSourceControlDisplaySections,
  groupSourceControlEntries,
  resolveSourceControlGroupOrder
} from '../../../../../../shared/source-control/listing/source-control-section-order'

// Module-scope body: React Compiler cannot lower component-scope try/finally or ref reads here.
export async function requestViewedMark({
  file,
  owner,
  key,
  scope,
  content,
  viewId,
  signature,
  records,
  isCurrentContent,
  isMounted,
  setPending,
  onFailure
}: {
  file: OpenFile
  owner: ReturnType<typeof getEditorFileReadContext>
  key: string
  scope: string
  content: DiffContent
  viewId?: string | null
  signature: string | null
  records: ReadonlyMap<string, ReviewedDiff>
  isCurrentContent: () => boolean
  isMounted: () => boolean
  setPending: (pending: boolean) => void
  onFailure: () => void
}): Promise<void> {
  try {
    const worktreePath = owner.worktreePath
    if (!worktreePath) {
      onFailure()
      return
    }
    const invokingState = useAppStore.getState()
    const invokingTab = editorViewTab(invokingState, file.id, viewId)
    const placement = editorViewPlacement(invokingState, file, viewId)
    const operation = acquireEditorFileOperation(useAppStore.getState, file)
    const modifiedTime =
      file.diffSource === 'commit'
        ? null
        : await statRuntimePath(operation.context, file.filePath).then(
            (stat) => stat.mtime,
            (error: unknown) => {
              if (isMissingRuntimePathError(error)) {
                return null
              }
              throw error
            }
          )
    operation.assertCurrent()
    if (!isMounted() || !isCurrentContent() || modifiedTime !== content.reviewModifiedTime) {
      return
    }
    const state = useAppStore.getState()
    const live = state.openFiles.find((candidate) => candidate.id === file.id)
    if (!live || live.isDirty || live.externalMutation) {
      return
    }
    const listKey = diffReviewListKey(diffReviewOwnerKey(owner), scope)
    let entries = getDiffReviewList(listKey)
    if (
      !entries.some((entry) => entry.key === key) &&
      (file.diffSource === 'unstaged' || file.diffSource === 'staged')
    ) {
      entries = buildUncommittedReviewEntries({
        owner,
        worktreeId: file.worktreeId,
        worktreePath: worktreePath,
        rows: buildSourceControlDisplaySections(
          groupSourceControlEntries(state.gitStatusByWorktree[file.worktreeId] ?? []),
          resolveSourceControlGroupOrder(state.settings?.sourceControlGroupOrder)
        )
          .flatMap((section) => section.items)
          .filter((entry) => !entry.conflictStatus && !entry.submodule),
        executionHostId: operation.provenance.generation.route.executionHostId ?? undefined,
        runtimeEnvironmentId:
          operation.provenance.generation.route.runtimeEnvironmentId ?? undefined
      })
    }
    if (!entries.some((entry) => entry.key === key) && file.diffSource === 'branch') {
      const compare = state.gitBranchCompareSummaryByWorktree[file.worktreeId]
      if (
        compare?.status === 'ready' &&
        compare.mergeBase === file.branchCompare?.mergeBase &&
        compare.headOid === file.branchCompare?.headOid
      ) {
        entries = [...(state.gitBranchChangesByWorktree[file.worktreeId] ?? [])]
          .sort(
            (a, b) =>
              Number(records.has(diffReviewKey(owner, a.path, scope))) -
                Number(records.has(diffReviewKey(owner, b.path, scope))) ||
              a.path.localeCompare(b.path)
          )
          .map((entry) => ({
            key: diffReviewKey(owner, entry.path, scope),
            entrySignature: reviewEntrySignature(entry),
            open: (targetPlacement) =>
              useAppStore
                .getState()
                .openBranchDiff(
                  file.worktreeId,
                  worktreePath,
                  entry,
                  compare,
                  detectLanguage(entry.path),
                  {
                    ...targetPlacement,
                    runtimeEnvironmentId:
                      operation.provenance.generation.route.runtimeEnvironmentId,
                    executionHostId:
                      operation.provenance.generation.route.executionHostId ?? undefined,
                    preview: true
                  }
                )
          }))
      }
    }
    const entry = entries.find((candidate) => candidate.key === key)
    const sourceEntry =
      file.diffSource === 'branch'
        ? (file.branchEntriesSnapshot ?? state.gitBranchChangesByWorktree[file.worktreeId])?.find(
            (row) => row.path === file.relativePath
          )
        : file.diffSource === 'commit'
          ? file.commitEntriesSnapshot?.find((row) => row.path === file.relativePath)
          : state.gitStatusByWorktree[file.worktreeId]?.find(
              (row) =>
                row.path === file.relativePath &&
                (row.area === 'staged') === (file.diffSource === 'staged')
            )
    const target = nextDiffReviewEntry(entries, key, getReviewedDiffs())
    setDiffReviewed(key, {
      viewedAt: Date.now(),
      modifiedTime,
      contentSignature: signature ?? '',
      entrySignature:
        entry?.entrySignature ?? (sourceEntry ? reviewEntrySignature(sourceEntry) : '')
    })
    const invokingGroup = state.groupsByWorktree[placement.placementWorkspaceId]?.find(
      (group) => group.id === placement.targetGroupId
    )
    const stillSelected = invokingTab
      ? invokingGroup?.activeTabId === invokingTab.id
      : state.activeFileId === file.id
    if (
      stillSelected &&
      state.activeWorktreeId === invokingState.activeWorktreeId &&
      state.activeGroupIdByWorktree[placement.placementWorkspaceId] ===
        invokingState.activeGroupIdByWorktree[placement.placementWorkspaceId]
    ) {
      target?.open(placement)
    }
  } catch {
    onFailure()
  } finally {
    if (isMounted()) {
      setPending(false)
    }
  }
}
