import { useCallback, useRef } from 'react'
import type React from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { openFilePreviewToSide } from '@/lib/file-preview'
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

  const writtenBySectionRef = useRef(
    new Map<string, { operation: DiffSection['operation']; content: string }>()
  )
  const runSectionSave = useCallback(
    async (
      sectionKey: string,
      mode: 'overwrite' | undefined,
      operation: NonNullable<DiffSection['operation']>
    ) => {
      // Why by key: rows can be rebuilt while a save waits; a gone section is not saved.
      const index = sectionsRef.current.findIndex((s) => s.key === sectionKey)
      const section = sectionsRef.current[index]
      if (!section || section.operation !== operation) {
        return
      }
      const modifiedEditor = modifiedEditorsRef.current.get(index)
      if (!modifiedEditor && !section.dirty) {
        return
      }

      const content = modifiedEditor?.getValue() ?? section.modifiedContent
      const absolutePath = joinPath(file.filePath, section.path)
      // Why: edits live in modifiedContent; the diff result keeps the text loaded from (or last
      // written to) disk, unless a large diff pruned it, in which case no version is known.
      // Why first: a save earlier in this section's chain wrote it, maybe before state caught up.
      const previousWrite = writtenBySectionRef.current.get(section.key)
      const loaded =
        (previousWrite?.operation === operation ? previousWrite.content : undefined) ??
        (section.diffResult?.kind === 'text' && !isPrunedTextDiffResult(section.diffResult)
          ? section.diffResult.modifiedContent
          : undefined)
      const markConflict = (): void =>
        setSections((prev) =>
          prev.map((s) =>
            s.key === sectionKey && s.operation === operation ? { ...s, saveConflict: true } : s
          )
        )
      if (loaded === undefined && mode !== 'overwrite') {
        markConflict()
        return
      }
      try {
        operation.assertCurrent()
        const writeResult = await withEditorFileWriteLock(
          editorPathHoldKey(useAppStore.getState(), operation.file, absolutePath),
          () => {
            operation.assertCurrent()
            return writeEditorSave(
              operation.mutationContext(),
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
          }
        )
        if (!writeResult.ok) {
          markConflict()
          return
        }
        try {
          operation.assertCurrent()
        } catch {
          return
        }
        // Why: the section list can be rebuilt while the write is pending, so re-resolve
        // by key — the captured index may now point at a different file.
        const savedIndex = sectionsRef.current.findIndex(
          (s) => s.key === sectionKey && s.operation === operation
        )
        if (savedIndex === -1) {
          return
        }
        writtenBySectionRef.current.set(sectionKey, { operation, content })
        setSectionHeights((prev) => removeDiffSectionMeasuredHeight(prev, savedIndex))
        setSections((prev) =>
          prev.map((s) => {
            if (s.key !== sectionKey || s.operation !== operation) {
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
    [file.filePath, sectionsRef, setSectionHeights, setSections]
  )

  // Build each precondition after that section’s prior save settles.
  const sectionSaveChainsRef = useRef(new Map<string, Promise<void>>())
  const handleSectionSave = useCallback(
    (index: number, mode?: 'overwrite'): Promise<void> => {
      const section = sectionsRef.current[index]
      const key = section?.key
      const operation = section?.operation
      if (key === undefined || !operation) {
        return Promise.resolve()
      }
      const chains = sectionSaveChainsRef.current
      const next = (chains.get(key) ?? Promise.resolve()).then(() =>
        runSectionSave(key, mode, operation)
      )
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
