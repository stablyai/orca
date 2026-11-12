import { useCallback, useLayoutEffect, useRef } from 'react'
import type React from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { getLargeDiffRenderLimit } from '../../../../../../shared/large-diff-render-limit'
import {
  getStoredTextDiffContent,
  getStoredTextDiffResult,
  isPrunedTextDiffResult
} from '../../diff/large-files/large-diff-section-content'
import { removeDiffSectionMeasuredHeight } from '../../diff/sections/diff-section-height-cache'
import { getDiskBaselineSignature } from '../../../../../../shared/file-write/disk-baseline-signature'
import { writeEditorSave } from '../../save/queue/editor-save-disk-precondition'
import { withEditorFileWriteLock } from '../../save/queue/editor-file-write-lock'
import { editorPathHoldKey } from '../../autosave/editor-autosave-holds'

export function useCombinedDiffSectionSave({
  file,
  sectionsRef,
  setSectionHeights,
  setSections
}: {
  file: OpenFile
  sectionsRef: React.RefObject<DiffSection[]>
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
}) {
  const modifiedEditorsRef = useRef<Map<number, monacoEditor.ICodeEditor>>(new Map())
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
  useLayoutEffect(() => {
    handleSectionSaveRef.current = handleSectionSave
  }, [handleSectionSave])

  return { handleSectionSaveRef, modifiedEditorsRef }
}
