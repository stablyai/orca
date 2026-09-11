import { useCallback, useLayoutEffect, useRef } from 'react'
import type React from 'react'
import { useAppStore } from '@/store'
import { joinPath } from '@/lib/path'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { writeRuntimeFile } from '@/runtime/runtime-file-client'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { OpenFile } from '@/store/slices/editor'
import { getLargeDiffRenderLimit } from '../../large-diff-render-limit'
import { getStoredTextDiffContent, getStoredTextDiffResult } from '../../large-diff-section-content'
import { removeDiffSectionMeasuredHeight } from '../../diff-section-height-cache'
import type { DiffSection } from '../../diff-section-types'
import type { DiffSectionItemProps } from '../../diff-section-item-props'

function acknowledgeSectionSave(section: DiffSection, content: string): DiffSection {
  if (section.modifiedContent !== content) {
    // The saved text is the new disk baseline; a later draft still belongs to the user.
    return {
      ...section,
      dirty: true,
      diffResult:
        section.diffResult?.kind === 'text'
          ? { ...section.diffResult, modifiedContent: content }
          : section.diffResult
    }
  }
  if (section.diffResult?.kind !== 'text') {
    return { ...section, dirty: false }
  }
  const diffResult = { ...section.diffResult, modifiedContent: content }
  const renderLimit = getLargeDiffRenderLimit({
    originalContent: section.originalContent,
    modifiedContent: content
  })
  return {
    ...section,
    ...getStoredTextDiffContent(diffResult, renderLimit),
    dirty: false,
    diffResult: getStoredTextDiffResult(diffResult, renderLimit),
    largeDiffRenderLimit: renderLimit
  }
}

export function useCombinedDiffSectionSave({
  file,
  requestSectionReloadRef,
  sectionsRef,
  setSectionHeights,
  setSections
}: {
  file: OpenFile
  requestSectionReloadRef: React.RefObject<(index: number) => void>
  sectionsRef: React.RefObject<DiffSection[]>
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
}): DiffSectionItemProps['handleSectionSaveRef'] {
  const savesRef = useRef(new Map<string, Promise<void>>())
  const saveSection = useCallback(
    (index: number): Promise<void> => {
      const requested = sectionsRef.current[index]
      if (!requested?.dirty || (requested.area !== 'unstaged' && requested.area !== 'untracked')) {
        return Promise.resolve()
      }
      const key = requested.key
      const generation = requested.contentGeneration
      const saves = savesRef.current
      const previous = saves.get(key) ?? Promise.resolve()
      const queued = previous
        .catch(() => undefined)
        .then(async () => {
          // Resolve by identity after earlier writes finish; ordering and drafts may have changed.
          const section = sectionsRef.current.find((entry) => entry.key === key)
          if (!section?.dirty || section.contentGeneration !== generation) {
            return
          }
          const content = section.modifiedContent
          const state = useAppStore.getState()
          const worktree = file.worktreeId
            ? findWorktreeById(state.worktreesByRepo, file.worktreeId)
            : null
          await writeRuntimeFile(
            getEditorFileOperationContext(state, file, worktree?.path ?? null),
            joinPath(file.filePath, section.path),
            content
          )
          const savedIndex = sectionsRef.current.findIndex(
            (entry) => entry.key === key && entry.contentGeneration === generation
          )
          if (savedIndex === -1) {
            return
          }
          setSectionHeights((prev) => removeDiffSectionMeasuredHeight(prev, savedIndex))
          setSections((prev) =>
            prev.map((entry) =>
              entry.key === key && entry.contentGeneration === generation
                ? acknowledgeSectionSave(entry, content)
                : entry
            )
          )
          // Why: a revalidation rejected while this row was dirty left the original side stale,
          // and the git-status signature does not change for an edit inside an already-modified
          // line, so nothing else re-drives it. The row is clean now, so the reload can proceed.
          requestSectionReloadRef.current(savedIndex)
        })
        .catch((error: unknown) => {
          console.error('Save failed:', error)
        })
      const tracked = queued.finally(() => {
        if (saves.get(key) === tracked) {
          saves.delete(key)
        }
      })
      saves.set(key, tracked)
      return tracked
    },
    [file, requestSectionReloadRef, sectionsRef, setSectionHeights, setSections]
  )
  const saveRef = useRef(saveSection)
  useLayoutEffect(() => {
    saveRef.current = saveSection
  }, [saveSection])
  return saveRef
}
