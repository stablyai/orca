/* oxlint-disable max-lines -- Why: content loading, retry, and external-change
   subscriptions share in-flight caches and state setters; splitting them would
   make the hook coordination harder to audit. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile, isWorktreeConnectionResolved } from '@/lib/connection-context'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import { getDiskBaselineSignature } from './diff-content-signature'
import { getRuntimeFileReadScope, readRuntimeFileContent } from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { findWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
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
  type EditorPanelContentLoadOptions,
  useEditorPanelExternalContentEvents,
  usePruneClosedEditorContent
} from './useEditorPanelExternalContentEvents'
import { useEditorPanelFileLoadRetry } from './useEditorPanelFileLoadRetry'
import { useLocalLogTail } from './useLocalLogTail'
import { migrateRestoredEditorFileOwner } from './migrate-restored-editor-file-owner'

type InFlightContentRead<T> = {
  externalEventGeneration?: number
  promise: Promise<T>
}

const inFlightFileReads = new Map<string, InFlightContentRead<FileContent>>()
const inFlightDiffReads = new Map<string, InFlightContentRead<DiffContent>>()

type GitStatusByWorktree = ReturnType<typeof useAppStore.getState>['gitStatusByWorktree']
type EditorViewModeByFile = ReturnType<typeof useAppStore.getState>['editorViewMode']

type UseEditorPanelContentStateParams = {
  activeFile: OpenFile | null
  isVisible?: boolean
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

// Why: the newest read for a tab is already on its way, so a re-run of the lazy
// effect (a worktree flip-flop re-adds `isVisible`) must not fire a second RPC.
// An invalidation bumps the tab's generation, so a superseded read never counts.
function hasLiveRead(
  generationsById: Record<string, number>,
  outstandingById: Record<string, number>,
  id: string
): boolean {
  const generation = generationsById[id]
  return generation !== undefined && outstandingById[id] === generation
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
  isVisible = true,
  isChangesMode,
  openFiles,
  gitStatusEntries,
  editorViewMode
}: UseEditorPanelContentStateParams): UseEditorPanelContentStateResult {
  const [fileContents, setFileContents] = useState<Record<string, FileContent>>({})
  const [diffContents, setDiffContents] = useState<Record<string, DiffContent>>({})
  const diffContentsRef = useRef(diffContents)
  const fileLoadRetryAttemptsRef = useRef<Record<string, number>>({})
  // Why: per-tab read generations let a forced/external reload supersede an
  // older in-flight read so a slower stale promise cannot overwrite fresh state.
  const fileReadGenerationRef = useRef<Record<string, number>>({})
  const diffReadGenerationRef = useRef<Record<string, number>>({})
  const fileReadGenerationCounterRef = useRef(0)
  const diffReadGenerationCounterRef = useRef(0)
  const outstandingFileReadsRef = useRef<Record<string, number>>({})
  const outstandingDiffReadsRef = useRef<Record<string, number>>({})
  const openFilesRef = useRef(openFiles)
  const editorViewModeRef = useRef(editorViewMode)
  const isVisibleRef = useRef(isVisible)
  const selectedConflictReviewFile =
    activeFile?.mode === 'conflict-review' && activeFile.conflictReview?.selectedFileId
      ? (openFiles.find((file) => file.id === activeFile.conflictReview?.selectedFileId) ?? null)
      : null
  const activeContentFileId = selectedConflictReviewFile?.id ?? activeFile?.id ?? null
  const activeContentFileIdRef = useRef(activeContentFileId)

  useLayoutEffect(() => {
    // Why: event-driven readers must only observe state from committed renders.
    diffContentsRef.current = diffContents
    openFilesRef.current = openFiles
    editorViewModeRef.current = editorViewMode
    isVisibleRef.current = isVisible
    activeContentFileIdRef.current = activeContentFileId
  }, [activeContentFileId, diffContents, editorViewMode, isVisible, openFiles])

  const invalidateFileContent = useCallback((fileIds: string[]): void => {
    const uniqueIds = new Set(fileIds)
    for (const fileId of uniqueIds) {
      fileReadGenerationRef.current[fileId] = ++fileReadGenerationCounterRef.current
      delete fileLoadRetryAttemptsRef.current[fileId]
    }
    setFileContents((prev) => {
      const next = { ...prev }
      let changed = false
      for (const fileId of uniqueIds) {
        const existing = next[fileId]
        // Why: keep the last-known bytes rendered and swap them when the lazy
        // reload lands — dropping them flashes "Loading…" on every reveal.
        if (existing && existing.isStale !== true) {
          next[fileId] = { ...existing, isStale: true }
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const invalidateDiffContent = useCallback((fileIds: string[]): void => {
    const uniqueIds = new Set(fileIds)
    for (const fileId of uniqueIds) {
      diffReadGenerationRef.current[fileId] = ++diffReadGenerationCounterRef.current
    }
    setDiffContents((prev) => {
      const next = { ...prev }
      let changed = false
      for (const fileId of uniqueIds) {
        const existing = next[fileId]
        // Why: keep the last-known diff rendered and swap it when the lazy
        // reload lands — dropping it flashes "Loading diff…" on every reveal.
        if (existing && existing.isStale !== true) {
          next[fileId] = { ...existing, isStale: true }
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const invalidateContent = useCallback(
    (fileIds: string[]): void => {
      invalidateFileContent(fileIds)
      invalidateDiffContent(fileIds)
    },
    [invalidateDiffContent, invalidateFileContent]
  )

  const loadFileContent = useCallback(
    async (
      filePath: string,
      id: string,
      worktreeId?: string,
      relativePath?: string,
      options?: EditorPanelContentLoadOptions
    ): Promise<void> => {
      const generation = fileReadGenerationCounterRef.current + 1
      fileReadGenerationCounterRef.current = generation
      fileReadGenerationRef.current[id] = generation
      outstandingFileReadsRef.current[id] = generation
      try {
        const resolvedConnectionId = getConnectionIdForFile(worktreeId ?? null, filePath)
        const connectionId = resolvedConnectionId ?? undefined
        const restoredOpenFile = openFilesRef.current.find((file) => file.id === id)
        const activeSettings = useAppStore.getState().settings
        const readSettings = settingsForRuntimeOwner(
          activeSettings,
          restoredOpenFile?.runtimeEnvironmentId
        )
        // Why: liveTail tabs are AI Vault logs discovered on this client, so the
        // worktree's SSH owner must never be inferred for them (a stamp still routes).
        const isLiveTailLogTab =
          restoredOpenFile?.readOnly === true && restoredOpenFile.liveTail === true
        let readConnectionId = connectionId
        let readWorktreeId = worktreeId
        let readRelativePath = restoredOpenFile?.relativePath ?? relativePath
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
          // Why: an out-of-worktree absolute path in an SSH workspace belongs to the
          // remote host, so the resolved connection owns it even when the tab predates
          // (or was opened outside) the terminal-link path that stamps the target id.
          const externalSshOwnerId =
            restoredOpenFile.externalSshTargetId?.trim() ||
            (isLiveTailLogTab ? undefined : connectionId)
          const runtimeEnvironmentId = isLiveTailLogTab
            ? undefined
            : readSettings?.activeRuntimeEnvironmentId?.trim()
          if (isLiveTailLogTab) {
            await window.api.fs.authorizeExternalPath({ targetPath: filePath })
            readConnectionId = undefined
          } else {
            const currentState = useAppStore.getState()
            const executionHostId = externalSshOwnerId
              ? toSshExecutionHostId(externalSshOwnerId)
              : runtimeEnvironmentId
                ? toRuntimeExecutionHostId(runtimeEnvironmentId)
                : LOCAL_EXECUTION_HOST_ID
            const route = findWorkspaceFileRoute(currentState, executionHostId, filePath)
            if (route && route.worktreeId !== worktreeId) {
              const migration = await migrateRestoredEditorFileOwner(
                id,
                route,
                runtimeEnvironmentId ?? null
              )
              fileReadGenerationRef.current[id] = ++fileReadGenerationCounterRef.current
              if (!migration.ok) {
                throw new Error(
                  migration.reason === 'collision'
                    ? 'The sibling file is already open; close one tab before restoring it.'
                    : 'The sibling file owner changed while the tab was restoring.'
                )
              }
              setFileContents((prev) => {
                const next = { ...prev }
                delete next[id]
                return next
              })
              return
            }
            if (runtimeEnvironmentId && !route) {
              throw new Error('External local files are not available for remote workspaces.')
            }
            if (!externalSshOwnerId) {
              // Why: client-local external tabs need their main-process path grant
              // refreshed because that authorization is only held in memory.
              await window.api.fs.authorizeExternalPath({ targetPath: filePath })
              // Why: that grant covers the client path, so this read must stay off the
              // worktree's SSH host.
              readConnectionId = undefined
            }
          }
        }
        const readScope = getRuntimeFileReadScope(readSettings, readConnectionId)
        const key = inFlightReadKey(readScope, filePath)
        const registeredRead = inFlightFileReads.get(key)
        if (
          options?.force &&
          (options.externalEventGeneration === undefined ||
            registeredRead?.externalEventGeneration !== options.externalEventGeneration)
        ) {
          // Why: forced reloads must not attach to a currently registered read
          // started before the external change landed.
          inFlightFileReads.delete(key)
        }
        let pending = inFlightFileReads.get(key)
        if (!pending) {
          const promise = readRuntimeFileContent({
            settings: readSettings,
            filePath,
            relativePath: readRelativePath,
            worktreeId: readWorktreeId,
            connectionId: readConnectionId,
            expectedExternalSshTargetId: restoredOpenFile?.externalSshTargetId,
            includeLocalLogMetadata: isLiveTailLogTab
          }) as Promise<FileContent>
          pending = { externalEventGeneration: options?.externalEventGeneration, promise }
          inFlightFileReads.set(key, pending)
          queueMicrotask(() => {
            if (inFlightFileReads.get(key) === pending) {
              inFlightFileReads.delete(key)
            }
          })
        }
        const result = await pending.promise
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
      } finally {
        if (outstandingFileReadsRef.current[id] === generation) {
          delete outstandingFileReadsRef.current[id]
        }
      }
    },
    []
  )

  const loadDiffContent = useCallback(
    async (file: OpenFile | null, options?: EditorPanelContentLoadOptions): Promise<void> => {
      if (!file || (file.mode === 'edit' && !canUseChangesModeForFile(file))) {
        return
      }
      const generation = diffReadGenerationCounterRef.current + 1
      diffReadGenerationCounterRef.current = generation
      diffReadGenerationRef.current[file.id] = generation
      outstandingDiffReadsRef.current[file.id] = generation
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
        const registeredRead = inFlightDiffReads.get(key)
        if (
          options?.force &&
          (options.externalEventGeneration === undefined ||
            registeredRead?.externalEventGeneration !== options.externalEventGeneration)
        ) {
          // Why: forced diff reloads must not attach to a read started before
          // the external change landed.
          inFlightDiffReads.delete(key)
        }
        let pending = inFlightDiffReads.get(key)
        if (!pending) {
          const promise = (
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
          pending = { externalEventGeneration: options?.externalEventGeneration, promise }
          inFlightDiffReads.set(key, pending)
          queueMicrotask(() => {
            if (inFlightDiffReads.get(key) === pending) {
              inFlightDiffReads.delete(key)
            }
          })
        }
        const result = await pending.promise
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
            modifiedContent: `Error loading diff: ${String(err)}`,
            originalIsBinary: false,
            modifiedIsBinary: false
          }
        }))
      } finally {
        if (outstandingDiffReadsRef.current[file.id] === generation) {
          delete outstandingDiffReadsRef.current[file.id]
        }
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

  const needsFileRead = (fileId: string): boolean => {
    const cached = fileContents[fileId]
    return (
      (!cached || cached.isStale === true) &&
      !hasLiveRead(fileReadGenerationRef.current, outstandingFileReadsRef.current, fileId)
    )
  }
  const needsDiffRead = (fileId: string): boolean => {
    const cached = diffContents[fileId]
    return (
      (!cached || cached.isStale === true) &&
      !hasLiveRead(diffReadGenerationRef.current, outstandingDiffReadsRef.current, fileId)
    )
  }

  useEffect(() => {
    if (!isVisible) {
      return
    }
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
        if (needsFileRead(absolutePath)) {
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
      if (needsFileRead(fileToLoad.id)) {
        void loadFileContent(
          fileToLoad.filePath,
          fileToLoad.id,
          fileToLoad.worktreeId,
          fileToLoad.relativePath
        )
      }
      if (isChangesMode && needsDiffRead(fileToLoad.id)) {
        void loadDiffContent(fileToLoad)
      }
    } else if (isReloadableSingleFileDiffTab(fileToLoad) && needsDiffRead(fileToLoad.id)) {
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
    isVisible,
    gitStatusEntries
  ])

  useEditorPanelFileLoadRetry({
    activeFile: isVisible ? activeFile : null,
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
    invalidateDiffContent([current.id])
    if (!isVisibleRef.current) {
      return
    }
    void loadDiffContent(current, { force: true })
  }, [activeFile?.diffContentReloadNonce, activeFile?.id, invalidateDiffContent, loadDiffContent])

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
    loadFileContent
  ])

  useEditorPanelExternalContentEvents({
    activeContentFileIdRef,
    invalidateContent,
    invalidateDiffContent,
    isVisibleRef,
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
