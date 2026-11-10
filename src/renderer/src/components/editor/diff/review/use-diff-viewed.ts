import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffContent } from '../../editor-panel-content-types'
import {
  acquireEditorFileOperation,
  getEditorFileReadContext
} from '@/lib/editor/file-operations/editor-file-operation-owner'
import {
  diffReviewKey,
  diffReviewOwnerKey,
  diffReviewScope,
  getReviewedDiffs,
  reviewEntrySignature,
  setDiffReviewed,
  useReviewedDiffs
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
import { diffReviewContentSignature } from './diff-review-content-signature'
import { joinPath } from '@/lib/path'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import {
  buildSourceControlDisplaySections,
  groupSourceControlEntries,
  resolveSourceControlGroupOrder
} from '../../../../../../shared/source-control/listing/source-control-section-order'

export function useDiffViewed(
  file: OpenFile,
  content: DiffContent | undefined,
  viewId?: string | null
) {
  const t = useTranslate()
  const records = useReviewedDiffs()
  const latestContent = useRef(content)
  latestContent.current = content
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [pending, setPending] = useState(false)
  const owner = useMemo(() => {
    try {
      return getEditorFileReadContext(
        useAppStore.getState(),
        file,
        file.filePath.slice(0, file.filePath.length - file.relativePath.length - 1)
      )
    } catch {
      return null
    }
  }, [file])
  const scope = diffReviewScope(file)
  const key = owner ? diffReviewKey(owner, file.relativePath, scope) : null
  const record = key ? records.get(key) : undefined
  const signature = useMemo(() => {
    if (
      !content ||
      content.isStale ||
      content.loadError ||
      (content.kind === 'text' ? content.largeDiffRenderLimit?.limited : content.tooLarge)
    ) {
      return null
    }
    return diffReviewContentSignature(content)
  }, [content])
  const viewed =
    !file.isDirty &&
    signature !== null &&
    record?.contentSignature === signature &&
    record.modifiedTime === content?.reviewModifiedTime
  const eligible =
    signature !== null &&
    content?.reviewModifiedTime !== undefined &&
    !file.isDirty &&
    !file.externalMutation &&
    !file.conflict

  const previousRead = useRef({ signature, modifiedTime: content?.reviewModifiedTime })
  useEffect(() => {
    const changed =
      previousRead.current.signature !== signature ||
      previousRead.current.modifiedTime !== content?.reviewModifiedTime
    previousRead.current = { signature, modifiedTime: content?.reviewModifiedTime }
    // Another surface's new mark must survive this surface's older cached read.
    if (!changed) {
      return
    }
    if (
      key &&
      record &&
      signature &&
      !content?.isStale &&
      (record.contentSignature !== signature ||
        (content?.reviewModifiedTime !== undefined &&
          record.modifiedTime !== content.reviewModifiedTime))
    ) {
      setDiffReviewed(key, null)
    }
  }, [key, record, signature, content])

  const toggle = async (): Promise<void> => {
    if (!owner || !key || !eligible || pending || !content) {
      return
    }
    if (viewed) {
      setDiffReviewed(key, null)
      return
    }
    setPending(true)
    try {
      const invokingState = useAppStore.getState()
      const invokingTab = editorViewTab(invokingState, file.id, viewId)
      const placement = editorViewPlacement(invokingState, file, viewId)
      const operation = acquireEditorFileOperation(useAppStore.getState, file)
      const modifiedTime = await statRuntimePath(operation.context, file.filePath).then(
        (stat) => stat.mtime,
        (error: unknown) => {
          if (isMissingRuntimePathError(error)) {
            return null
          }
          throw error
        }
      )
      operation.assertCurrent()
      if (
        !mounted.current ||
        latestContent.current !== content ||
        modifiedTime !== content.reviewModifiedTime
      ) {
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
        entries.length === 0 &&
        (file.diffSource === 'unstaged' || file.diffSource === 'staged')
      ) {
        const rows = buildSourceControlDisplaySections(
          groupSourceControlEntries(state.gitStatusByWorktree[file.worktreeId] ?? []),
          resolveSourceControlGroupOrder(state.settings?.sourceControlGroupOrder)
        )
          .flatMap((section) => section.items)
          .filter((entry) => !entry.conflictStatus && !entry.submodule)
        entries = rows.map((entry) => ({
          key: diffReviewKey(owner, entry.path, entry.area === 'staged' ? 'staged' : 'unstaged'),
          entrySignature: reviewEntrySignature(entry),
          open: (placement) =>
            useAppStore
              .getState()
              .openDiff(
                file.worktreeId,
                joinPath(owner.worktreePath!, entry.path),
                entry.path,
                detectLanguage(entry.path),
                entry.area === 'staged',
                {
                  ...placement,
                  runtimeEnvironmentId: operation.provenance.generation.route.runtimeEnvironmentId,
                  executionHostId:
                    operation.provenance.generation.route.executionHostId ?? undefined,
                  preview: true,
                  oldPath: entry.area === 'staged' ? entry.oldPath : undefined
                }
              )
        }))
      }
      if (entries.length === 0 && file.diffSource === 'branch') {
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
                    owner.worktreePath!,
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
        contentSignature: signature!,
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
      if (mounted.current) {
        toast.error(
          t(
            'diffReview.failed',
            "Couldn't mark this file as viewed. Reopen the diff and try again."
          )
        )
      }
    } finally {
      if (mounted.current) {
        setPending(false)
      }
    }
  }
  return { viewed, disabled: !eligible || !owner || pending, toggle }
}
