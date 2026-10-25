import { useCallback, useRef } from 'react'
import type React from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { openFilePreviewToSide } from '@/lib/file-preview'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { OpenFile } from '@/store/slices/editor'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import { canOpenDiffSectionPreviewToSide } from '../../diff-section-preview'
import { getLargeDiffRenderLimit } from '../../large-diff-render-limit'
import {
  getStoredTextDiffContent,
  getStoredTextDiffResult,
  isPrunedTextDiffResult
} from '../../large-diff-section-content'
import { removeDiffSectionMeasuredHeight } from '../../diff-section-height-cache'
import type { DiffSection } from '../../diff-section-types'
import type { DiffSectionItemProps } from '../../diff-section-item-props'
import { getDiskBaselineSignature } from '../../../../../../shared/disk-baseline-signature'
import { writeEditorSave } from '../../editor-save-disk-precondition'
import { withEditorFileWriteLock } from '../../editor-file-write-lock'
import { editorPathHoldKey } from '../../editor-autosave-holds'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

export type CombinedDiffSectionActions = {
  handleSectionSaveRef: DiffSectionItemProps['handleSectionSaveRef']
  modifiedEditorsRef: DiffSectionItemProps['modifiedEditorsRef']
  openSection: (index: number) => void
  openSectionPreview: (section: DiffSection) => void
}

export function useCombinedDiffSectionActions({
  activeGroupId,
  branchCompare,
  canOpenWorkspaceFileBrowserForPath,
  commitCompare,
  file,
  isAllMode,
  isBranchMode,
  isCommitMode,
  sectionsRef,
  setSectionHeights,
  setSections
}: {
  activeGroupId: string | undefined
  branchCompare: NonNullable<OpenFile['branchCompare']> | null
  canOpenWorkspaceFileBrowserForPath: (path: string) => boolean
  commitCompare: NonNullable<OpenFile['commitCompare']> | null
  file: OpenFile
  isAllMode: boolean
  isBranchMode: boolean
  isCommitMode: boolean
  sections: DiffSection[]
  sectionsRef: React.RefObject<DiffSection[]>
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
}): CombinedDiffSectionActions {
  const openFile = useAppStore((s) => s.openFile)
  const openBranchDiff = useAppStore((s) => s.openBranchDiff)
  const openCommitDiff = useAppStore((s) => s.openCommitDiff)
  const modifiedEditorsRef = useRef<Map<number, monacoEditor.IStandaloneCodeEditor>>(new Map())

  const openSection = useCallback(
    (index: number) => {
      const section = sectionsRef.current[index]
      if (!section) {
        return
      }

      const language = detectLanguage(section.path)
      const entry: GitBranchChangeEntry = {
        path: section.path,
        status: section.status as GitBranchChangeEntry['status'],
        oldPath: section.oldPath,
        added: section.added,
        removed: section.removed
      }

      const isBranchEntry = section.area === undefined

      if ((isBranchMode || (isAllMode && isBranchEntry)) && branchCompare) {
        openBranchDiff(file.worktreeId, file.filePath, entry, branchCompare, language)
        return
      }

      if (isCommitMode && commitCompare) {
        openCommitDiff(file.worktreeId, file.filePath, entry, commitCompare, language)
        return
      }

      openFile({
        filePath: joinPath(file.filePath, section.path),
        relativePath: section.path,
        worktreeId: file.worktreeId,
        runtimeEnvironmentId: file.runtimeEnvironmentId,
        language,
        mode: 'edit'
      })
    },
    [
      branchCompare,
      commitCompare,
      file.filePath,
      file.runtimeEnvironmentId,
      file.worktreeId,
      isAllMode,
      isBranchMode,
      isCommitMode,
      openBranchDiff,
      openCommitDiff,
      openFile,
      sectionsRef
    ]
  )

  // Match single-file HTML diffs by previewing the on-disk working file beside this combined view.
  const openSectionPreview = useCallback(
    (section: DiffSection) => {
      if (
        !canOpenDiffSectionPreviewToSide({
          path: section.path,
          status: section.status,
          isCommitSurface: isCommitMode,
          canOpenWorkspaceFileBrowser: canOpenWorkspaceFileBrowserForPath(
            joinPath(file.filePath, section.path)
          )
        })
      ) {
        return
      }
      // Use this tab’s split group; the workspace active group may belong to another pane.
      const state = useAppStore.getState()
      const sourceGroupId =
        (state.unifiedTabsByWorktree[file.worktreeId] ?? []).find(
          (tab) =>
            tab.entityId === file.id && (tab.contentType === 'diff' || tab.contentType === 'editor')
        )?.groupId ??
        activeGroupId ??
        null
      openFilePreviewToSide({
        language: detectLanguage(section.path),
        filePath: joinPath(file.filePath, section.path),
        worktreeId: file.worktreeId,
        sourceGroupId
      })
    },
    [
      activeGroupId,
      canOpenWorkspaceFileBrowserForPath,
      file.filePath,
      file.id,
      file.worktreeId,
      isCommitMode
    ]
  )

  const writtenBySectionRef = useRef(new Map<string, string>())
  const runSectionSave = useCallback(
    async (sectionKey: string, mode?: 'overwrite') => {
      // Resolve by key after queued saves; rows may move or disappear while waiting.
      const index = sectionsRef.current.findIndex((s) => s.key === sectionKey)
      const section = sectionsRef.current[index]
      if (!section) {
        return
      }
      const modifiedEditor = modifiedEditorsRef.current.get(index)
      if (!modifiedEditor && !section.dirty) {
        return
      }

      const content = modifiedEditor?.getValue() ?? section.modifiedContent
      const absolutePath = joinPath(file.filePath, section.path)
      // Prefer the prior queued write’s baseline, which may precede state updates; otherwise use unpruned loaded disk text, never the edited draft.
      const loaded =
        writtenBySectionRef.current.get(section.key) ??
        (section.diffResult?.kind === 'text' && !isPrunedTextDiffResult(section.diffResult)
          ? section.diffResult.modifiedContent
          : undefined)
      const markConflict = (): void =>
        setSections((prev) =>
          prev.map((s) => (s.key === sectionKey ? { ...s, saveConflict: true } : s))
        )
      if (loaded === undefined && mode !== 'overwrite') {
        markConflict()
        return
      }
      try {
        const state = useAppStore.getState()
        const worktree = file.worktreeId
          ? findWorktreeById(selectWorktreesByRepo(state), file.worktreeId)
          : null
        const owner = {
          worktreeId: file.worktreeId,
          runtimeEnvironmentId: file.runtimeEnvironmentId,
          operationProvenance: file.operationProvenance
        }
        const context = getEditorFileOperationContext(state, owner, worktree?.path ?? null)
        // Share the path write lock with ordinary editor tabs.
        const writeResult = await withEditorFileWriteLock(
          editorPathHoldKey(state, owner, absolutePath),
          () =>
            writeEditorSave(
              context,
              absolutePath,
              content,
              undefined,
              mode === 'overwrite' || loaded === undefined
                ? { kind: 'explicit-overwrite' }
                : {
                    kind: 'guarded',
                    signature: getDiskBaselineSignature(loaded),
                    allowMissing: false
                  }
            )
        )
        if (!writeResult.ok) {
          markConflict()
          return
        }
        writtenBySectionRef.current.set(sectionKey, content)
        // Re-resolve by key after writing; rebuilt section lists can move the saved file to another index.
        const savedIndex = sectionsRef.current.findIndex((s) => s.key === sectionKey)
        if (savedIndex === -1) {
          return
        }
        setSectionHeights((prev) => removeDiffSectionMeasuredHeight(prev, savedIndex))
        setSections((prev) =>
          prev.map((s) => {
            if (s.key !== sectionKey) {
              return s
            }
            const written =
              s.diffResult?.kind === 'text' ? { ...s.diffResult, modifiedContent: content } : null
            // Typing during the write is newer intent; advance only the baseline.
            if (s.modifiedContent !== content) {
              return written ? { ...s, diffResult: written, saveConflict: undefined } : s
            }
            if (!written) {
              return { ...s, dirty: false, saveConflict: undefined }
            }
            const nextLargeDiffRenderLimit = getLargeDiffRenderLimit({
              originalContent: s.originalContent,
              modifiedContent: content
            })
            const storedContent = getStoredTextDiffContent(written, nextLargeDiffRenderLimit)
            return {
              ...s,
              modifiedContent: storedContent.modifiedContent,
              originalContent: storedContent.originalContent,
              dirty: false,
              saveConflict: undefined,
              diffResult: getStoredTextDiffResult(written, nextLargeDiffRenderLimit),
              largeDiffRenderLimit: nextLargeDiffRenderLimit
            }
          })
        )
      } catch (err) {
        console.error('Save failed:', err)
      }
    },
    [
      file.filePath,
      file.operationProvenance,
      file.runtimeEnvironmentId,
      file.worktreeId,
      sectionsRef,
      setSectionHeights,
      setSections
    ]
  )

  // Build each precondition after that section’s prior save settles.
  const sectionSaveChainsRef = useRef(new Map<string, Promise<void>>())
  const handleSectionSave = useCallback(
    (index: number, mode?: 'overwrite'): Promise<void> => {
      const key = sectionsRef.current[index]?.key
      if (key === undefined) {
        return Promise.resolve()
      }
      const chains = sectionSaveChainsRef.current
      const next = (chains.get(key) ?? Promise.resolve()).then(() => runSectionSave(key, mode))
      const tracked = next.finally(() => {
        if (chains.get(key) === tracked) {
          chains.delete(key)
          writtenBySectionRef.current.delete(key)
        }
      })
      chains.set(key, tracked)
      return tracked
    },
    [runSectionSave, sectionsRef]
  )

  const handleSectionSaveRef = useRef(handleSectionSave)
  handleSectionSaveRef.current = handleSectionSave

  return { handleSectionSaveRef, modifiedEditorsRef, openSection, openSectionPreview }
}
