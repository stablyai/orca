import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { getRuntimeFileReadScope, readRuntimeFileContent } from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import {
  getRuntimeGitBranchDiff,
  getRuntimeGitCommitDiff,
  getRuntimeGitDiff,
  getRuntimeGitScope
} from '@/runtime/runtime-git-client'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import { canUseChangesModeForFile } from './editor-panel-file-mode'
import {
  useEditorPanelExternalContentEvents,
  usePruneClosedEditorContent
} from './useEditorPanelExternalContentEvents'
import { useEditorPanelFileLoadRetry } from './useEditorPanelFileLoadRetry'

const inFlightFileReads = new Map<string, Promise<FileContent>>()
const inFlightDiffReads = new Map<string, Promise<DiffContent>>()

type GitStatusByWorktree = ReturnType<typeof useAppStore.getState>['gitStatusByWorktree']
type EditorViewModeByFile = ReturnType<typeof useAppStore.getState>['editorViewMode']

type UseEditorPanelContentStateParams = {
  activeFile: OpenFile | null
  isChangesMode: boolean
  openFiles: OpenFile[]
  gitStatusByWorktree: GitStatusByWorktree
  editorViewMode: EditorViewModeByFile
}

type UseEditorPanelContentStateResult = {
  fileContents: Record<string, FileContent>
  diffContents: Record<string, DiffContent>
  reloadFileContent: (file: OpenFile) => void
}

function inFlightReadKey(connectionId: string | undefined, filePath: string): string {
  return `${connectionId ?? ''}::${filePath}`
}

function inFlightDiffKey(
  file: OpenFile,
  connectionId: string | undefined,
  compareAgainstHead = false
): string {
  const branch =
    file.diffSource === 'branch' && file.branchCompare
      ? `${file.branchCompare.baseOid ?? ''}..${file.branchCompare.headOid ?? ''}::${file.branchOldPath ?? ''}`
      : ''
  const commit =
    file.diffSource === 'commit' && file.commitCompare
      ? `${file.commitCompare.parentOid ?? 'empty-tree'}..${file.commitCompare.commitOid}::${file.branchOldPath ?? ''}`
      : ''
  return `${connectionId ?? ''}::${file.diffSource ?? ''}::${compareAgainstHead ? 'head' : 'default'}::${file.filePath}::${branch}::${commit}`
}

export function useEditorPanelContentState({
  activeFile,
  isChangesMode,
  openFiles,
  gitStatusByWorktree,
  editorViewMode
}: UseEditorPanelContentStateParams): UseEditorPanelContentStateResult {
  const [fileContents, setFileContents] = useState<Record<string, FileContent>>({})
  const [diffContents, setDiffContents] = useState<Record<string, DiffContent>>({})
  const fileLoadRetryAttemptsRef = useRef<Record<string, number>>({})
  const openFilesRef = useRef(openFiles)
  openFilesRef.current = openFiles
  const editorViewModeRef = useRef(editorViewMode)
  editorViewModeRef.current = editorViewMode

  const loadFileContent = useCallback(
    async (filePath: string, id: string, worktreeId?: string): Promise<void> => {
      try {
        const connectionId = getConnectionId(worktreeId ?? null) ?? undefined
        const restoredOpenFile = openFilesRef.current.find((file) => file.id === id)
        const activeSettings = useAppStore.getState().settings
        const readSettings = settingsForRuntimeOwner(
          activeSettings,
          restoredOpenFile?.runtimeEnvironmentId
        )
        if (restoredOpenFile?.filePath === filePath && restoredOpenFile.relativePath === filePath) {
          if (readSettings?.activeRuntimeEnvironmentId?.trim() || connectionId) {
            // Why: restored external-file tabs contain client-local absolute
            // paths. Remote runtime and SSH workspaces cannot read those paths
            // without an explicit upload/import flow.
            throw new Error('External local files are not available for remote workspaces.')
          }
          // Why: restored external-file tabs need their main-process path grant
          // refreshed because that authorization is only held in memory.
          await window.api.fs.authorizeExternalPath({ targetPath: filePath })
        }
        const readScope = getRuntimeFileReadScope(readSettings, connectionId)
        const key = inFlightReadKey(readScope, filePath)
        let pending = inFlightFileReads.get(key)
        if (!pending) {
          pending = readRuntimeFileContent({
            settings: readSettings,
            filePath,
            relativePath: restoredOpenFile?.relativePath,
            worktreeId,
            connectionId
          }) as Promise<FileContent>
          inFlightFileReads.set(key, pending)
          queueMicrotask(() => {
            if (inFlightFileReads.get(key) === pending) {
              inFlightFileReads.delete(key)
            }
          })
        }
        const result = await pending
        delete fileLoadRetryAttemptsRef.current[id]
        setFileContents((prev) => ({ ...prev, [id]: result }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setFileContents((prev) => ({
          ...prev,
          [id]: { content: '', isBinary: false, loadError: message }
        }))
      }
    },
    []
  )

  const loadDiffContent = useCallback(async (file: OpenFile | null): Promise<void> => {
    if (!file || (file.mode === 'edit' && !canUseChangesModeForFile(file))) {
      return
    }
    try {
      const worktreePath = file.filePath.slice(
        0,
        file.filePath.length - file.relativePath.length - 1
      )
      const branchCompare =
        file.branchCompare?.baseOid && file.branchCompare.headOid && file.branchCompare.mergeBase
          ? file.branchCompare
          : null
      const commitCompare = file.commitCompare?.commitOid ? file.commitCompare : null
      const connectionId = getConnectionId(file.worktreeId) ?? undefined
      const activeSettings = useAppStore.getState().settings
      const fileSettings = settingsForRuntimeOwner(activeSettings, file.runtimeEnvironmentId)
      const gitScope = getRuntimeGitScope(fileSettings, connectionId)
      const effectiveDiffSource: typeof file.diffSource =
        file.mode === 'edit' ? 'unstaged' : file.diffSource
      const compareAgainstHead = file.mode === 'edit'
      const key = inFlightDiffKey(
        { ...file, diffSource: effectiveDiffSource },
        gitScope,
        compareAgainstHead
      )
      let pending = inFlightDiffReads.get(key)
      if (!pending) {
        pending = (
          effectiveDiffSource === 'commit'
            ? commitCompare
              ? getRuntimeGitCommitDiff(
                  {
                    settings: fileSettings,
                    worktreeId: file.worktreeId,
                    worktreePath,
                    connectionId
                  },
                  {
                    commitOid: commitCompare.commitOid,
                    parentOid: commitCompare.parentOid,
                    filePath: file.relativePath,
                    oldPath: file.branchOldPath
                  }
                )
              : Promise.reject(new Error('Missing commit comparison for diff tab.'))
            : effectiveDiffSource === 'branch' && branchCompare
              ? getRuntimeGitBranchDiff(
                  {
                    settings: fileSettings,
                    worktreeId: file.worktreeId,
                    worktreePath,
                    connectionId
                  },
                  {
                    compare: {
                      baseRef: branchCompare.baseRef,
                      baseOid: branchCompare.baseOid!,
                      headOid: branchCompare.headOid!,
                      mergeBase: branchCompare.mergeBase!
                    },
                    filePath: file.relativePath,
                    oldPath: file.branchOldPath
                  }
                )
              : getRuntimeGitDiff(
                  {
                    settings: fileSettings,
                    worktreeId: file.worktreeId,
                    worktreePath,
                    connectionId
                  },
                  {
                    filePath: file.relativePath,
                    staged: effectiveDiffSource === 'staged',
                    compareAgainstHead
                  }
                )
        ) as Promise<DiffContent>
        inFlightDiffReads.set(key, pending)
        queueMicrotask(() => {
          if (inFlightDiffReads.get(key) === pending) {
            inFlightDiffReads.delete(key)
          }
        })
      }
      const result = await pending
      setDiffContents((prev) => ({ ...prev, [file.id]: result }))
    } catch (err) {
      setDiffContents((prev) => ({
        ...prev,
        [file.id]: {
          kind: 'text',
          originalContent: '',
          modifiedContent: `Error loading diff: ${err}`,
          originalIsBinary: false,
          modifiedIsBinary: false
        }
      }))
    }
  }, [])

  const reloadFileContent = useCallback(
    (file: OpenFile): void => {
      delete fileLoadRetryAttemptsRef.current[file.id]
      setFileContents((prev) => {
        if (!prev[file.id]) {
          return prev
        }
        const next = { ...prev }
        delete next[file.id]
        return next
      })
      void loadFileContent(file.filePath, file.id, file.worktreeId)
    },
    [loadFileContent]
  )

  useEffect(() => {
    if (!activeFile || activeFile.mode === 'conflict-review') {
      return
    }
    if (activeFile.mode === 'edit' || activeFile.mode === 'markdown-preview') {
      if (activeFile.conflict?.kind === 'conflict-placeholder') {
        return
      }
      if (!fileContents[activeFile.id]) {
        void loadFileContent(activeFile.filePath, activeFile.id, activeFile.worktreeId)
      }
      if (isChangesMode && !diffContents[activeFile.id]) {
        void loadDiffContent(activeFile)
      }
    } else if (
      activeFile.mode === 'diff' &&
      activeFile.diffSource !== undefined &&
      activeFile.diffSource !== 'combined-uncommitted' &&
      activeFile.diffSource !== 'combined-branch' &&
      activeFile.diffSource !== 'combined-commit' &&
      !diffContents[activeFile.id]
    ) {
      void loadDiffContent(activeFile)
    }
  }, [activeFile?.id, isChangesMode]) // eslint-disable-line react-hooks/exhaustive-deps

  useEditorPanelFileLoadRetry({
    activeFile,
    fileContents,
    fileLoadRetryAttemptsRef,
    loadFileContent,
    openFilesRef,
    setFileContents
  })

  const changesStatusEntries = activeFile?.worktreeId
    ? gitStatusByWorktree[activeFile.worktreeId]
    : undefined
  useEffect(() => {
    if (!isChangesMode || !activeFile?.id) {
      return
    }
    const current = openFilesRef.current.find((f) => f.id === activeFile.id)
    if (current) {
      void loadDiffContent(current)
    }
  }, [
    changesStatusEntries,
    isChangesMode,
    activeFile?.id,
    activeFile?.worktreeId,
    activeFile?.relativePath,
    loadDiffContent
  ])

  useEditorPanelExternalContentEvents({
    loadDiffContent,
    loadFileContent,
    openFilesRef,
    editorViewModeRef,
    setFileContents,
    setDiffContents
  })
  usePruneClosedEditorContent(openFiles, fileLoadRetryAttemptsRef, setFileContents, setDiffContents)

  return { fileContents, diffContents, reloadFileContent }
}
