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

export function useCombinedDiffSectionLoader({
  entrySet,
  file,
  registry,
  sectionCount,
  setSectionHeights,
  setSections
}: {
  entrySet: CombinedDiffEntrySet
  file: OpenFile
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
    sectionsRef
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

      const largeDiffRenderLimit =
        !error && result.kind === 'text'
          ? (result.largeDiffRenderLimit ??
            getLargeDiffRenderLimit({
              originalContent: result.originalContent,
              modifiedContent: result.modifiedContent
            }))
          : null

      if (generationRef.current !== gen) {
        // Why: the generation reset already cleared the in-flight set, and a newer load for this
        // index may own the entry now — deleting it here would hide that load from the guard above.
        return
      }
      loadingIndicesRef.current.delete(index)
      if ((sectionLoadTokensRef.current.get(index) ?? 0) !== loadToken) {
        // Why: an invalidation landed mid-flight and deferred its reload to this settle point, so
        // the refetch happens once here instead of racing a second fetch against this one.
        requestSectionReloadRef.current(index)
        return
      }
      const storedContent = getStoredTextDiffContent(result, largeDiffRenderLimit)
      const storedResult = getStoredTextDiffResult(result, largeDiffRenderLimit)
      loadedIndicesRef.current.add(index)
      const current = sectionsRef.current[index]
      // A revalidation lands on a section that is already showing content. If the refetch matches
      // what's on screen, committing it would swap Monaco models and re-measure for nothing.
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
        return
      }
      if (wasShowingContent) {
        // Why: content really changed, so the old Monaco height no longer describes this row.
        setSectionHeights((prev) => removeDiffSectionMeasuredHeight(prev, index))
      }
      setSections((prev) => {
        return prev.map((s, i) =>
          i === index
            ? {
                ...s,
                diffResult: storedResult,
                originalContent: storedContent.originalContent,
                modifiedContent: storedContent.modifiedContent,
                loading: false,
                error,
                largeDiffRenderLimit,
                // Why: models are keyed by path, so a changed refetch must not reuse the old model.
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
      isAllMode,
      isBranchMode,
      isCommitMode,
      renderableBranchEntries,
      uncommittedEntries
    ]
  )
  loadSectionRef.current = loadSectionNow

  // Progressive loading: queue diff content when a section becomes visible.
  const loadSection = useCallback(
    (index: number) => {
      if (sectionsRef.current[index]?.collapsed || sectionsRef.current[index]?.loadOnDemand) {
        return
      }
      loadSchedulerRef.current.request(index)
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
    // Why: queue the first rows deterministically so the visible viewport doesn't depend on IntersectionObserver delivery.
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
        loadSection(index)
      }
    }
  }, [entrySignature, loadSection, loadedIndicesRef, sectionCount, sectionsRef])

  return { loadSection, loadDeferredSection }
}
