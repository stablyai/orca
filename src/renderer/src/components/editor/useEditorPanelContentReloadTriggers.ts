import { useEffect, useMemo, type MutableRefObject } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type { useAppStore } from '@/store'
import type { DiffContent } from './editor-panel-content-types'
import {
  isReloadableSingleFileDiffTab,
  shouldReloadDiffOnGitStatusChange
} from './editor-panel-diff-reload'
import type { EditorPanelDiffContentLoader } from './useEditorPanelDiffContentLoader'
import type { EditorPanelFileContentLoader } from './useEditorPanelFileContentLoader'

type GitStatusByWorktree = ReturnType<typeof useAppStore.getState>['gitStatusByWorktree']

type UseEditorPanelContentReloadTriggersParams = {
  activeFile: OpenFile | null
  gitStatusEntries: GitStatusByWorktree[string] | undefined
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
  const activeFileShouldReloadOnGitStatusChange = useMemo(
    () =>
      activeFile
        ? shouldReloadDiffOnGitStatusChange(activeFile, activeFileGitStatusEntries)
        : false,
    [activeFile, activeFileGitStatusEntries]
  )
  useEffect(() => {
    if (!activeFile?.id) {
      return
    }
    const current = openFilesRef.current.find((f) => f.id === activeFile.id)
    if (!current) {
      return
    }
    if (!(isChangesMode || activeFileShouldReloadOnGitStatusChange)) {
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
    void loadDiffContent(current, { force: true })
  }, [
    activeFileShouldReloadOnGitStatusChange,
    activeFileGitStatusSignature,
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
