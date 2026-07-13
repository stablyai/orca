/* oxlint-disable max-lines -- Why: content loading, retry, and external-change
   subscriptions share in-flight caches and state setters; splitting them would
   make the hook coordination harder to audit. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile, isWorktreeConnectionResolved } from '@/lib/connection-context'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import { getDiskBaselineSignature } from './diff-content-signature'
import { getRuntimeFileReadScope, readRuntimeFileContent } from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import {
  getRuntimeGitBranchDiff,
  getRuntimeGitCommitDiff,
  getRuntimeGitDiff,
  getRuntimeGitScope
} from '@/runtime/runtime-git-client'
import {
  WORKTREE_OWNER_NOT_READY_ERROR,
  type DiffContent,
  type FileContent
} from './editor-panel-content-types'
import { canUseChangesModeForFile } from './editor-panel-file-mode'
import {
  isReloadableSingleFileDiffTab,
  shouldReloadDiffOnGitStatusChange
} from './editor-panel-diff-reload'
import {
  useEditorPanelExternalContentEvents,
  usePruneClosedEditorContent
} from './useEditorPanelExternalContentEvents'
import { useEditorPanelFileLoadRetry } from './useEditorPanelFileLoadRetry'
import { useLocalLogTail } from './useLocalLogTail'

const inFlightFileReads = new Map<string, Promise<FileContent>>()
const inFlightDiffReads = new Map<string, Promise<DiffContent>>()

type GitStatusByWorktree = ReturnType<typeof useAppStore.getState>['gitStatusByWorktree']
type EditorViewModeByFile = ReturnType<typeof useAppStore.getState>['editorViewMode']

type UseEditorPanelContentStateParams = {
  activeFile: OpenFile | null
  isChangesMode: boolean
  openFiles: OpenFile[]
  gitStatusEntries: GitStatusByWorktree[string] | undefined
  editorViewMode: EditorViewModeByFile
}

type UseEditorPanelContentStateResult = {
  fileContents: Record<string, FileContent>
  diffContents: Record<string, DiffContent>
  reloadContent: (file: OpenFile) => void
}

// Why: a clean load re-baselines what this tab's future edits are based on; a
// dirty tab keeps its baseline (its draft still derives from the older content
// the signature was taken over). Best-effort metadata — a failure here must
// not convert an already-delivered load into an error view, hence the guard.
function stampCleanTabDiskBaseline(id: string, result: FileContent): void {
  if (result.isBinary || result.loadError) {
    return
  }
  try {
    const state = useAppStore.getState()
    const loadedFile = state.openFiles.find((file) => file.id === id)
    if (loadedFile && !loadedFile.isDirty) {
      state.setLastKnownDiskSignature(id, getDiskBaselineSignature(result.content))
    }
  } catch (err) {
    console.warn('[editor] failed to stamp disk baseline', err)
  }
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
  gitStatusEntries,
  editorViewMode
}: UseEditorPanelContentStateParams): UseEditorPanelContentStateResult {
  const [fileContents, setFileContents] = useState<Record<string, FileContent>>({})
  const [diffContents, setDiffContents] = useState<Record<string, DiffContent>>({})
  const diffContentsRef = useRef(diffContents)
  diffContentsRef.current = diffContents
  const fileLoadRetryAttemptsRef = useRef<Record<string, number>>({})
  // Why: per-tab read generations let a forced/external reload supersede an
  // older in-flight read so a slower stale promise cannot overwrite fresh state.
  const fileReadGenerationRef = useRef<Record<string, number>>({})
  const diffReadGenerationRef = useRef<Record<string, number>>({})
  const fileReadGenerationCounterRef = useRef(0)
  const diffReadGenerationCounterRef = useRef(0)
  const openFilesRef = useRef(openFiles)
  openFilesRef.current = openFiles
  const editorViewModeRef = useRef(editorViewMode)
  editorViewModeRef.current = editorViewMode
  const selectedConflictReviewFile =
    activeFile?.mode === 'conflict-review' && activeFile.conflictReview?.selectedFileId
      ? (openFiles.find((file) => file.id === activeFile.conflictReview?.selectedFileId) ?? null)
      : null

  const loadFileContent = useCallback(
    async (
      filePath: string,
      id: string,
      worktreeId?: string,
      relativePath?: string,
      options?: { force?: boolean }
    ): Promise<void> => {
      const generation = fileReadGenerationCounterRef.current + 1
      fileReadGenerationCounterRef.current = generation
      fileReadGenerationRef.current[id] = generation
      try {
        const resolvedConnectionId = getConnectionIdForFile(worktreeId ?? null, filePath)
        const connectionId = resolvedConnectionId ?? undefined
        const restoredOpenFile = openFilesRef.current.find((file) => file.id === id)
        const activeSettings = useAppStore.getState().settings
        const readSettings = settingsForRuntimeOwner(
          activeSettings,
          restoredOpenFile?.runtimeEnvironmentId
        )
        if (
          resolvedConnectionId === undefined &&
          !readSettings?.activeRuntimeEnvironmentId?.trim() &&
          !isWorktreeConnectionResolved(worktreeId ?? null)
        ) {
          // Why: the backing repo hasn't hydrated yet (SSH still connecting), so
          // we can't tell local from remote. Reading locally would deny a remote
          // path with a terminal "access denied" (#6648); fail retryably instead.
          throw new Error(WORKTREE_OWNER_NOT_READY_ERROR)
        }
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
        if (options?.force) {
          // Why: forced reloads must not attach to a currently registered read
          // started before the external change landed.
          inFlightFileReads.delete(key)
        }
        let pending = inFlightFileReads.get(key)
        if (!pending) {
          pending = readRuntimeFileContent({
            settings: readSettings,
            filePath,
            relativePath: restoredOpenFile?.relativePath ?? relativePath,
            worktreeId,
            connectionId,
            includeLocalLogMetadata:
              restoredOpenFile?.readOnly === true && restoredOpenFile.liveTail === true
          }) as Promise<FileContent>
          inFlightFileReads.set(key, pending)
          queueMicrotask(() => {
            if (inFlightFileReads.get(key) === pending) {
              inFlightFileReads.delete(key)
            }
          })
        }
        const result = await pending
        if (fileReadGenerationRef.current[id] !== generation) {
          return
        }
        delete fileLoadRetryAttemptsRef.current[id]
        setFileContents((prev) => ({ ...prev, [id]: result }))
        stampCleanTabDiskBaseline(id, result)
      } catch (err) {
        if (fileReadGenerationRef.current[id] !== generation) {
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setFileContents((prev) => ({
          ...prev,
          [id]: { content: '', isBinary: false, loadError: message }
        }))
      }
    },
    []
  )

  const loadDiffContent = useCallback(
    async (file: OpenFile | null, options?: { force?: boolean }): Promise<void> => {
      if (!file || (file.mode === 'edit' && !canUseChangesModeForFile(file))) {
        return
      }
      const generation = diffReadGenerationCounterRef.current + 1
      diffReadGenerationCounterRef.current = generation
      diffReadGenerationRef.current[file.id] = generation
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
        const connectionId = getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined
        const activeSettings = useAppStore.getState().settings
        const fileSettings = settingsForRuntimeOwner(activeSettings, file.runtimeEnvironmentId)
        const gitScope = getRuntimeGitScope(fileSettings, connectionId)
        const effectiveDiffSource: typeof file.diffSource =
          file.mode === 'edit' ? 'unstaged' : file.diffSource
        const compareAgainstHead = file.mode === 'edit'
        const key = inFlightDiffKey(
          { ...file, diffSource: effectiveDiffSource },
          gitScope ?? undefined,
          compareAgainstHead
        )
        if (options?.force) {
          // Why: forced diff reloads must not attach to a read started before
          // the external change landed.
          inFlightDiffReads.delete(key)
        }
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
        if (diffReadGenerationRef.current[file.id] !== generation) {
          return
        }
        setDiffContents((prev) => ({ ...prev, [file.id]: result }))
      } catch (err) {
        if (diffReadGenerationRef.current[file.id] !== generation) {
          return
        }
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
    },
    []
  )

  // Why: the changed-on-disk banner's explicit reload on an unstaged diff tab
  // must refetch the diff body, not the plain file content — one entry point
  // branches on the tab mode so every consumer reloads the right store.
  const reloadContent = useCallback(
    (file: OpenFile): void => {
      if (file.mode === 'diff') {
        setDiffContents((prev) => {
          if (!prev[file.id]) {
            return prev
          }
          const next = { ...prev }
          delete next[file.id]
          return next
        })
        void loadDiffContent(file, { force: true })
        return
      }
      delete fileLoadRetryAttemptsRef.current[file.id]
      setFileContents((prev) => {
        if (!prev[file.id]) {
          return prev
        }
        const next = { ...prev }
        delete next[file.id]
        return next
      })
      void loadFileContent(file.filePath, file.id, file.worktreeId, file.relativePath, {
        force: true
      })
    },
    [loadDiffContent, loadFileContent]
  )

  useLocalLogTail({ openFiles, fileContents, setFileContents, reloadContent })

  useEffect(() => {
    if (activeFile?.mode === 'conflict-review' && !selectedConflictReviewFile) {
      const snapshotEntries = activeFile.conflictReview?.entries ?? []
      if (snapshotEntries.length === 0) {
        return
      }

      const snapshotPaths = new Set(snapshotEntries.map((entry) => entry.path))
      const liveEntries = gitStatusEntries ?? []
      for (const entry of liveEntries) {
        if (
          !snapshotPaths.has(entry.path) ||
          entry.conflictStatus !== 'unresolved' ||
          !entry.conflictKind ||
          entry.status === 'deleted'
        ) {
          continue
        }

        const absolutePath = joinPath(activeFile.filePath, entry.path)
        if (!fileContents[absolutePath]) {
          void loadFileContent(absolutePath, absolutePath, activeFile.worktreeId, entry.path)
        }
      }
      return
    }

    const fileToLoad = selectedConflictReviewFile ?? activeFile
    if (!fileToLoad || (activeFile?.mode === 'conflict-review' && !selectedConflictReviewFile)) {
      return
    }
    if (fileToLoad.mode === 'edit' || fileToLoad.mode === 'markdown-preview') {
      if (fileToLoad.conflict?.kind === 'conflict-placeholder') {
        return
      }
      if (!fileContents[fileToLoad.id]) {
        void loadFileContent(
          fileToLoad.filePath,
          fileToLoad.id,
          fileToLoad.worktreeId,
          fileToLoad.relativePath
        )
      }
      if (isChangesMode && !diffContents[fileToLoad.id]) {
        void loadDiffContent(fileToLoad)
      }
    } else if (isReloadableSingleFileDiffTab(fileToLoad) && !diffContents[fileToLoad.id]) {
      void loadDiffContent(fileToLoad)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeFile?.id,
    activeFile?.mode,
    activeFile?.conflictReview?.selectedFileId,
    activeFile?.conflictReview?.snapshotTimestamp,
    selectedConflictReviewFile?.id,
    isChangesMode,
    gitStatusEntries
  ])

  useEditorPanelFileLoadRetry({
    activeFile,
    fileContents,
    fileLoadRetryAttemptsRef,
    loadFileContent,
    openFilesRef,
    setFileContents
  })

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
    // Why: the lazy-load effect already fetches on first open; forcing here
    // races a duplicate git-diff RPC for the same tab.
    if (!diffContentsRef.current[current.id]) {
      return
    }
    void loadDiffContent(current, { force: true })
  }, [
    activeFileShouldReloadOnGitStatusChange,
    activeFileGitStatusSignature,
    isChangesMode,
    activeFile?.id,
    loadDiffContent
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
    setDiffContents((prev) => {
      if (!prev[current.id]) {
        return prev
      }
      const next = { ...prev }
      delete next[current.id]
      return next
    })
    void loadDiffContent(current, { force: true })
  }, [activeFile?.diffContentReloadNonce, activeFile?.id, loadDiffContent])

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
    setFileContents((prev) => {
      if (!prev[current.id]) {
        return prev
      }
      const next = { ...prev }
      delete next[current.id]
      return next
    })
    void loadFileContent(current.filePath, current.id, current.worktreeId, current.relativePath, {
      force: true
    })
  }, [activeFile?.fileContentReloadNonce, activeFile?.filePath, activeFile?.id, loadFileContent])

  useEditorPanelExternalContentEvents({
    loadDiffContent,
    loadFileContent,
    openFilesRef,
    editorViewModeRef,
    setFileContents,
    setDiffContents
  })
  usePruneClosedEditorContent(
    openFiles,
    fileLoadRetryAttemptsRef,
    fileReadGenerationRef,
    diffReadGenerationRef,
    setFileContents,
    setDiffContents
  )

  return { fileContents, diffContents, reloadContent }
}
