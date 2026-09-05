import { useCallback, useEffect, useMemo, useRef } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { buildActiveOpenFileSignature, buildActiveOpenRowKeys } from './active-open-file-keys'
import type { FlatEntry } from './use-selection'
import {
  isSourceControlSplitOpenModifier,
  shouldOpenSourceControlRowAsPreview,
  type SourceControlRowOpenEvent
} from './split-open'

export function useSourceControlRowOpening({
  isMac,
  activeWorktreeId,
  worktreePath,
  visibleSelectionEntries,
  branchSummary
}: {
  isMac: boolean
  activeWorktreeId: string | null
  worktreePath: string | null
  visibleSelectionEntries: FlatEntry[]
  branchSummary: GitBranchCompareSummary | null
}) {
  const activeGroupIdByWorktree = useAppStore((s) => s.activeGroupIdByWorktree)
  const groupsByWorktree = useAppStore((s) => s.groupsByWorktree)
  const createEmptySplitGroup = useAppStore((s) => s.createEmptySplitGroup)
  const trackConflictPath = useAppStore((s) => s.trackConflictPath)
  const openConflictFile = useAppStore((s) => s.openConflictFile)
  const openDiff = useAppStore((s) => s.openDiff)
  const openFile = useAppStore((s) => s.openFile)
  const setEditorViewMode = useAppStore((s) => s.setEditorViewMode)
  const openBranchDiff = useAppStore((s) => s.openBranchDiff)

  // Why: modifier-click keeps the current pane intact by opening the file in a fresh split to the right.
  const resolveSplitTargetGroupId = useCallback(
    (event?: SourceControlRowOpenEvent): string | undefined => {
      if (!event || !activeWorktreeId || !isSourceControlSplitOpenModifier(event, isMac)) {
        return undefined
      }
      const sourceGroupId =
        activeGroupIdByWorktree[activeWorktreeId] ?? groupsByWorktree[activeWorktreeId]?.[0]?.id
      if (!sourceGroupId) {
        return undefined
      }
      return createEmptySplitGroup(activeWorktreeId, sourceGroupId, 'right') ?? undefined
    },
    [activeGroupIdByWorktree, activeWorktreeId, createEmptySplitGroup, groupsByWorktree, isMac]
  )

  // Why: a stable string signature keeps this selector referentially stable so the panel re-renders only when the active editor file changes; null when the tab isn't an editor.
  const activeOpenFileSignature = useAppStore((s) => {
    if (!activeWorktreeId || s.activeTabTypeByWorktree?.[activeWorktreeId] !== 'editor') {
      return null
    }
    const activeFileId = s.activeFileIdByWorktree?.[activeWorktreeId]
    if (!activeFileId) {
      return null
    }
    const activeFile = s.openFiles?.find(
      (file) => file.id === activeFileId && file.worktreeId === activeWorktreeId
    )
    return activeFile
      ? buildActiveOpenFileSignature(activeFile.diffSource, activeFile.relativePath)
      : null
  })
  const activeOpenAvailableRowKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const entry of visibleSelectionEntries) {
      keys.add(entry.key)
    }
    return keys
  }, [visibleSelectionEntries])
  const activeOpenRowKeys = useMemo(
    () => buildActiveOpenRowKeys(activeOpenFileSignature, activeOpenAvailableRowKeys),
    [activeOpenAvailableRowKeys, activeOpenFileSignature]
  )

  const handleOpenDiff = useCallback(
    (entry: GitStatusEntry, event?: SourceControlRowOpenEvent) => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      const targetGroupId = resolveSplitTargetGroupId(event)
      const openAsPreview = shouldOpenSourceControlRowAsPreview(event, targetGroupId)
      if (entry.conflictKind && entry.conflictStatus) {
        if (entry.conflictStatus === 'unresolved') {
          trackConflictPath(activeWorktreeId, entry.path, entry.conflictKind)
        }
        openConflictFile(activeWorktreeId, worktreePath, entry, detectLanguage(entry.path), {
          targetGroupId,
          preview: openAsPreview
        })
        return
      }
      const language = detectLanguage(entry.path)
      const filePath = joinPath(worktreePath, entry.path)
      // Why: unstaged markdown diffs open as an edit tab in Changes view (one tab per file); staged diffs still get a separate diff tab since that isn't what the editor edits.
      if (language === 'markdown' && entry.area === 'unstaged') {
        openFile(
          {
            filePath,
            relativePath: entry.path,
            worktreeId: activeWorktreeId,
            language,
            mode: 'edit'
          },
          { targetGroupId, preview: openAsPreview }
        )
        setEditorViewMode(filePath, 'changes')
        return
      }
      openDiff(activeWorktreeId, filePath, entry.path, language, entry.area === 'staged', {
        targetGroupId,
        preview: openAsPreview
      })
    },
    [
      activeWorktreeId,
      worktreePath,
      resolveSplitTargetGroupId,
      trackConflictPath,
      openConflictFile,
      openDiff,
      openFile,
      setEditorViewMode
    ]
  )

  const openCommittedDiff = useCallback(
    (entry: GitBranchChangeEntry, event?: SourceControlRowOpenEvent) => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        !branchSummary ||
        branchSummary.status !== 'ready'
      ) {
        return
      }
      const targetGroupId = resolveSplitTargetGroupId(event)
      openBranchDiff(
        activeWorktreeId,
        worktreePath,
        entry,
        branchSummary,
        detectLanguage(entry.path),
        { targetGroupId, preview: shouldOpenSourceControlRowAsPreview(event, targetGroupId) }
      )
    },
    [activeWorktreeId, branchSummary, openBranchDiff, resolveSplitTargetGroupId, worktreePath]
  )

  // Bridge the editor's F7/Shift+F7 diff-change nav across file edges: when the
  // cursor is at the file's last/first change, advance to the adjacent changed
  // file honoring exactly the order/filtering shown in this panel. Reads latest
  // values via refs so the registration stays stable and doesn't churn — not
  // useEffectEvent, whose contract forbids calling it outside an Effect, and the
  // store hands this function to a keyboard handler.
  const setChangedFileDiffNavigator = useAppStore((s) => s.setChangedFileDiffNavigator)
  const visibleSelectionEntriesRef = useRef(visibleSelectionEntries)
  visibleSelectionEntriesRef.current = visibleSelectionEntries
  const activeOpenRowKeysRef = useRef(activeOpenRowKeys)
  activeOpenRowKeysRef.current = activeOpenRowKeys
  const handleOpenDiffRef = useRef(handleOpenDiff)
  handleOpenDiffRef.current = handleOpenDiff
  useEffect(() => {
    const navigate = (direction: 'next' | 'previous'): boolean => {
      const entries = visibleSelectionEntriesRef.current
      const activeKeys = activeOpenRowKeysRef.current
      // Why: activeOpenRowKeys may hold both unstaged:: and untracked:: keys for
      // one path, but git makes those row kinds mutually exclusive per path, so
      // first match is the only match.
      const currentIndex = entries.findIndex((entry) => activeKeys.has(entry.key))
      if (currentIndex === -1) {
        return false
      }
      const adjacent = entries[direction === 'next' ? currentIndex + 1 : currentIndex - 1]
      if (!adjacent) {
        return false
      }
      handleOpenDiffRef.current(adjacent.entry)
      return true
    }
    setChangedFileDiffNavigator(navigate)
    return () => {
      // Identity guard: a late unmount must not wipe a newer panel's registration.
      if (useAppStore.getState().changedFileDiffNavigator === navigate) {
        setChangedFileDiffNavigator(null)
      }
    }
  }, [setChangedFileDiffNavigator])

  return { resolveSplitTargetGroupId, activeOpenRowKeys, handleOpenDiff, openCommittedDiff }
}
