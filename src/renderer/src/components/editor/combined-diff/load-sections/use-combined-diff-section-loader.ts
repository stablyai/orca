import { useCallback, useEffect } from 'react'
import type React from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type {
  GitBranchChangeEntry,
  GitDiffResult
} from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiffSection } from '../../diff-section-types'
import { getLargeDiffRenderLimit } from '../../large-diff-render-limit'
import { getStoredTextDiffContent, getStoredTextDiffResult } from '../../large-diff-section-content'
import { removeDiffSectionMeasuredHeight } from '../../diff-section-height-cache'
import type { CombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { fetchCombinedDiffSection } from './fetch-combined-diff-section'
import { getDiffSectionLoadErrorMessage } from './combined-diff-section-load-timeout'
import { getInitialCombinedDiffSectionLoadIndices } from './combined-diff-initial-section-load'
import { isUnchangedDiffSectionReload } from './combined-diff-section-load-state'
import type { CombinedDiffSectionLoadRegistry } from './combined-diff-section-load-registry'
import type { CombinedDiffLoadRequest } from './combined-diff-load-scheduler'

export function useCombinedDiffSectionLoader({
  entrySet,
  file,
  generation,
  registry,
  sectionCount,
  setSectionHeights,
  setSections
}: {
  entrySet: CombinedDiffEntrySet
  file: OpenFile
  generation: number
  registry: CombinedDiffSectionLoadRegistry
  sectionCount: number
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
}): {
  loadSection: (index: number) => void
  loadDeferredSection: (index: number) => void
} {
  const {
    allEntries,
    branchCompare,
    commitCompare,
    commitEntries,
    entrySignature,
    isAllMode,
    isBranchMode,
    isCommitMode,
    renderableBranchEntries,
    uncommittedEntries
  } = entrySet
  const {
    deferredLoadRequestsRef,
    generationRef,
    loadSchedulerRef,
    loadSectionRef,
    loadedIndicesRef,
    loadingIndicesRef,
    requestSectionReloadRef,
    sectionLoadTokensRef,
    sectionsRef,
    supersededLoadIndicesRef
  } = registry

  const loadSectionNow = useCallback(
    async (index: number) => {
      if (sectionsRef.current[index]?.loadOnDemand && !deferredLoadRequestsRef.current.has(index)) {
        return
      }
      deferredLoadRequestsRef.current.delete(index)
      if (loadedIndicesRef.current.has(index) || loadingIndicesRef.current.has(index)) {
        return
      }
      loadingIndicesRef.current.add(index)

      const gen = generationRef.current
      const loadToken = sectionLoadTokensRef.current.get(index) ?? 0
      const entries: (GitStatusEntry | GitBranchChangeEntry)[] = isAllMode
        ? allEntries
        : isBranchMode
          ? renderableBranchEntries
          : isCommitMode
            ? commitEntries
            : uncommittedEntries
      const entry = entries[index]
      if (!entry) {
        loadingIndicesRef.current.delete(index)
        return
      }

      let result: GitDiffResult
      let error: string | undefined
      try {
        result = await fetchCombinedDiffSection({
          branchCompare,
          commitCompare,
          entry,
          file,
          isAllMode,
          isBranchMode,
          isCommitMode
        })
      } catch (err) {
        error = getDiffSectionLoadErrorMessage(err)
        result = {
          kind: 'text',
          originalContent: '',
          modifiedContent: '',
          originalIsBinary: false,
          modifiedIsBinary: false
        } as GitDiffResult
      }

      if (generationRef.current !== gen) {
        // Generation reset already cleared the set; a newer load may now own this index.
        return
      }
      loadingIndicesRef.current.delete(index)
      const invalidatedMidFlight = (sectionLoadTokensRef.current.get(index) ?? 0) !== loadToken
      if (invalidatedMidFlight && !supersededLoadIndicesRef.current.has(index)) {
        // Refetch once at settlement after mid-flight invalidation rather than racing a duplicate load.
        supersededLoadIndicesRef.current.add(index)
        requestSectionReloadRef.current(index)
        return
      }
      // Sustained writes can invalidate every fetch; commit after one discard and refetch again to avoid starving visible updates.
      supersededLoadIndicesRef.current.delete(index)
      // User edits outrank incoming disk content.
      if (sectionsRef.current[index]?.dirty) {
        loadedIndicesRef.current.add(index)
        return
      }
      if (invalidatedMidFlight) {
        queueMicrotask(() => requestSectionReloadRef.current(index))
      }
      const largeDiffRenderLimit =
        !error && result.kind === 'text'
          ? (result.largeDiffRenderLimit ??
            getLargeDiffRenderLimit({
              originalContent: result.originalContent,
              modifiedContent: result.modifiedContent
            }))
          : null
      const storedContent = getStoredTextDiffContent(result, largeDiffRenderLimit)
      const storedResult = getStoredTextDiffResult(result, largeDiffRenderLimit)
      loadedIndicesRef.current.add(index)
      const current = sectionsRef.current[index]
      // Identical revalidation must not swap Monaco models or remeasure an unchanged row.
      const wasShowingContent = current !== undefined && !current.loading
      if (
        wasShowingContent &&
        isUnchangedDiffSectionReload(current, {
          diffResult: storedResult,
          error,
          largeDiffRenderLimit,
          originalContent: storedContent.originalContent,
          modifiedContent: storedContent.modifiedContent
        })
      ) {
        // Persist the newly loaded index even when the body and its model stay unchanged.
        setSections((prev) => [...prev])
        return
      }
      if (wasShowingContent) {
        setSectionHeights((prev) => removeDiffSectionMeasuredHeight(prev, index))
      }
      setSections((prev) => {
        return prev.map((s, i) =>
          i === index && !s.dirty
            ? {
                ...s,
                diffResult: storedResult,
                originalContent: storedContent.originalContent,
                modifiedContent: storedContent.modifiedContent,
                loading: false,
                error,
                largeDiffRenderLimit,
                // Changed content needs a fresh generation because model paths otherwise retain the old snapshot.
                contentGeneration: wasShowingContent
                  ? (s.contentGeneration ?? 0) + 1
                  : s.contentGeneration
              }
            : s
        )
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      branchCompare?.baseOid,
      branchCompare?.headOid,
      branchCompare?.mergeBase,
      allEntries,
      commitCompare?.commitOid,
      commitCompare?.parentOid,
      commitEntries,
      file.filePath,
      file.runtimeEnvironmentId,
      file.worktreeId,
      isAllMode,
      isBranchMode,
      isCommitMode,
      renderableBranchEntries,
      uncommittedEntries
    ]
  )
  loadSectionRef.current = loadSectionNow

  const loadSection = useCallback(
    (index: number, options: CombinedDiffLoadRequest = { viewportOnly: true }) => {
      if (sectionsRef.current[index]?.collapsed || sectionsRef.current[index]?.loadOnDemand) {
        return
      }
      loadSchedulerRef.current.request(index, options)
    },
    [loadSchedulerRef, sectionsRef]
  )

  const loadDeferredSection = useCallback(
    (index: number): void => {
      const section = sectionsRef.current[index]
      if (!section?.loadOnDemand) {
        return
      }
      deferredLoadRequestsRef.current.add(index)
      setSections((prev) =>
        prev.map((item, itemIndex) =>
          itemIndex === index ? { ...item, loadOnDemand: false, loading: true } : item
        )
      )
      loadSchedulerRef.current.request(index)
    },
    [deferredLoadRequestsRef, loadSchedulerRef, sectionsRef, setSections]
  )

  useEffect(() => {
    // Queue initial rows deterministically so viewport loading cannot depend on IntersectionObserver delivery.
    const currentSections = sectionsRef.current
    for (let index = 0; index < currentSections.length; index += 1) {
      if (currentSections[index]?.loading && loadedIndicesRef.current.has(index)) {
        loadedIndicesRef.current.delete(index)
      }
    }

    const initialIndices = getInitialCombinedDiffSectionLoadIndices({
      sectionCount: currentSections.length,
      loadedIndices: loadedIndicesRef.current
    })

    for (const index of initialIndices) {
      if (!currentSections[index]?.collapsed) {
        loadSection(index, { viewportOnly: false })
      }
    }
  }, [entrySignature, generation, loadSection, loadedIndicesRef, sectionCount, sectionsRef])

  return { loadSection, loadDeferredSection }
}
