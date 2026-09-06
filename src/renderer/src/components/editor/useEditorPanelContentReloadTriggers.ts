import { useEffect, useMemo, type MutableRefObject } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type { useAppStore } from '@/store'
import type { GitBranchCompareSummary } from '../../../../shared/git-diff-compare-types'
import type { DiffContent } from './editor-panel-content-types'
import {
  getChangedLineDiffFile,
  shouldLoadChangedLineDiffForEditFile
} from './editor-panel-changed-line-diff'
import {
  isReloadableSingleFileDiffTab,
  shouldReloadDiffOnGitStatusChange
} from './editor-panel-diff-reload'
import type { EditorPanelDiffContentLoader } from './useEditorPanelDiffContentLoader'
import type { EditorPanelFileContentLoader } from './useEditorPanelFileContentLoader'

type GitStatusByWorktree = ReturnType<typeof useAppStore.getState>['gitStatusByWorktree']
type GitBranchChangesByWorktree = ReturnType<
  typeof useAppStore.getState
>['gitBranchChangesByWorktree']

type UseEditorPanelContentReloadTriggersParams = {
  activeFile: OpenFile | null
  gitStatusEntries: GitStatusByWorktree[string] | undefined
  gitBranchEntries: GitBranchChangesByWorktree[string] | undefined
  gitBranchCompareSummary: GitBranchCompareSummary | null | undefined
  changedLineHighlightsEnabled: boolean
  isChangesMode: boolean
  diffContentsRef: MutableRefObject<Record<string, DiffContent>>
  isVisibleRef: MutableRefObject<boolean>
  openFilesRef: MutableRefObject<OpenFile[]>
  invalidateDiffContent: (fileIds: string[]) => void
  invalidateFileContent: (fileIds: string[]) => void
  loadDiffContent: EditorPanelDiffContentLoader
  loadFileContent: EditorPanelFileContentLoader
}

export function useEditorPanelContentReloadTriggers({
  activeFile,
  gitStatusEntries,
  gitBranchEntries,
  gitBranchCompareSummary,
  changedLineHighlightsEnabled,
  isChangesMode,
  diffContentsRef,
  isVisibleRef,
  openFilesRef,
  invalidateDiffContent,
  invalidateFileContent,
  loadDiffContent,
  loadFileContent
}: UseEditorPanelContentReloadTriggersParams): void {
  const changesStatusEntries = activeFile?.worktreeId ? gitStatusEntries : undefined
  const activeFileGitStatusEntries = useMemo(() => {
    if (!activeFile?.relativePath || !changesStatusEntries) {
      return undefined
    }
    return changesStatusEntries.filter((entry) => entry.path === activeFile.relativePath)
  }, [activeFile?.relativePath, changesStatusEntries])
  const activeFileGitBranchEntries = useMemo(() => {
    if (!activeFile?.relativePath || !gitBranchEntries) {
      return undefined
    }
    return gitBranchEntries.filter((entry) => entry.path === activeFile.relativePath)
  }, [activeFile?.relativePath, gitBranchEntries])
  const activeFileGitStatusSignature = useMemo(() => {
    if (!activeFileGitStatusEntries) {
      return ''
    }
    return JSON.stringify(
      activeFileGitStatusEntries.map((entry) => ({
        area: entry.area,
        status: entry.status,
        conflictStatus: entry.conflictStatus
      }))
    )
  }, [activeFileGitStatusEntries])
  const activeFileGitBranchSignature = useMemo(() => {
    if (!activeFileGitBranchEntries) {
      return ''
    }
    return JSON.stringify(
      activeFileGitBranchEntries.map((entry) => ({
        oldPath: entry.oldPath,
        status: entry.status,
        added: entry.added,
        removed: entry.removed
      }))
    )
  }, [activeFileGitBranchEntries])
  const branchCompare = useMemo(
    () =>
      gitBranchCompareSummary?.status === 'ready'
        ? {
            baseRef: gitBranchCompareSummary.baseRef,
            compareRef: gitBranchCompareSummary.compareRef,
            compareVersion: gitBranchCompareSummary.compareRef,
            baseOid: gitBranchCompareSummary.baseOid,
            headOid: gitBranchCompareSummary.headOid,
            mergeBase: gitBranchCompareSummary.mergeBase
          }
        : null,
    [
      gitBranchCompareSummary?.baseOid,
      gitBranchCompareSummary?.baseRef,
      gitBranchCompareSummary?.compareRef,
      gitBranchCompareSummary?.headOid,
      gitBranchCompareSummary?.mergeBase,
      gitBranchCompareSummary?.status
    ]
  )
  const activeFileShouldReloadOnGitStatusChange = useMemo(
    () =>
      activeFile
        ? shouldReloadDiffOnGitStatusChange(activeFile, activeFileGitStatusEntries)
        : false,
    [activeFile, activeFileGitStatusEntries]
  )
  const activeFileShouldReloadChangedLineDiff = useMemo(
    () =>
      changedLineHighlightsEnabled &&
      shouldLoadChangedLineDiffForEditFile(
        activeFile,
        activeFileGitStatusEntries,
        activeFileGitBranchEntries
      ),
    [
      activeFile,
      activeFileGitBranchEntries,
      activeFileGitStatusEntries,
      changedLineHighlightsEnabled
    ]
  )
  useEffect(() => {
    if (!activeFile?.id) {
      return
    }
    const current = openFilesRef.current.find((f) => f.id === activeFile.id)
    if (!current) {
      return
    }
    if (
      !(
        isChangesMode ||
        activeFileShouldReloadOnGitStatusChange ||
        activeFileShouldReloadChangedLineDiff
      )
    ) {
      return
    }
    if (!isVisibleRef.current) {
      invalidateDiffContent([current.id])
      return
    }
    // Why: the lazy-load effect already fetches on first open and on a retained
    // stale entry; forcing here races a duplicate git-diff RPC for the same tab.
    const cachedDiff = diffContentsRef.current[current.id]
    if (!cachedDiff || cachedDiff.isStale === true) {
      return
    }
    const changedLineDiffFile = activeFileShouldReloadChangedLineDiff
      ? getChangedLineDiffFile(
          current,
          activeFileGitStatusEntries,
          activeFileGitBranchEntries,
          branchCompare
        )
      : null
    if (activeFileShouldReloadChangedLineDiff && !changedLineDiffFile) {
      return
    }
    void loadDiffContent(changedLineDiffFile ?? current, { force: true })
  }, [
    activeFileShouldReloadOnGitStatusChange,
    activeFileShouldReloadChangedLineDiff,
    activeFileGitBranchEntries,
    activeFileGitStatusSignature,
    activeFileGitBranchSignature,
    activeFileGitStatusEntries,
    branchCompare,
    isChangesMode,
    activeFile?.id,
    invalidateDiffContent,
    loadDiffContent,
    diffContentsRef,
    isVisibleRef,
    openFilesRef
  ])

  useEffect(() => {
    const nonce = activeFile?.diffContentReloadNonce
    if (!activeFile?.id || nonce === undefined || nonce === 0) {
      return
    }
    const current = openFilesRef.current.find((f) => f.id === activeFile.id)
    if (!current || !isReloadableSingleFileDiffTab(current)) {
      return
    }
    invalidateDiffContent([current.id])
    if (!isVisibleRef.current) {
      return
    }
    void loadDiffContent(current, { force: true })
  }, [
    activeFile?.diffContentReloadNonce,
    activeFile?.id,
    invalidateDiffContent,
    loadDiffContent,
    isVisibleRef,
    openFilesRef
  ])

  useEffect(() => {
    const nonce = activeFile?.fileContentReloadNonce
    if (!activeFile?.id || nonce === undefined || nonce === 0) {
      return
    }
    const current = openFilesRef.current.find((f) => f.id === activeFile.id)
    if (
      !current ||
      current.isDirty ||
      (current.mode !== 'edit' && current.mode !== 'markdown-preview')
    ) {
      return
    }
    invalidateFileContent([current.id])
    if (!isVisibleRef.current) {
      return
    }
    void loadFileContent(current.filePath, current.id, current.worktreeId, current.relativePath, {
      force: true
    })
  }, [
    activeFile?.fileContentReloadNonce,
    activeFile?.filePath,
    activeFile?.id,
    invalidateFileContent,
    loadFileContent,
    isVisibleRef,
    openFilesRef
  ])
}
