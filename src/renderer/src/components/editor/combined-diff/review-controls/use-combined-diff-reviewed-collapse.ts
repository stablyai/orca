import { acquireCombinedDiffSectionOperation } from '../load-sections/combined-diff-section-connection'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import {
  getReviewedDiffs,
  reviewEntrySignature,
  setDiffReviewed,
  useReviewedDiffs,
  type ReviewedDiff,
  type DiffReviewEntry
} from '@/lib/editor/diff-reviewed-files'
import { joinPath } from '@/lib/path'
import {
  isMissingRuntimePathError,
  statRuntimePath
} from '@/runtime/files/metadata/runtime-file-metadata-client'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import type { CombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { getCombinedDiffFileTreeSectionKey } from '../resolve-changes/combined-diff-section-identity'
import { combinedDiffReviewIdentity } from './combined-diff-review-identity'
import { readAppState } from '@/store'
import { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { useRevalidateSourceControlReviews } from '@/components/right-sidebar/source-control/listing/use-source-control-review'

export function useCombinedDiffReviewedCollapse({
  file,
  entrySet,
  setSections,
  viewStateKey
}: {
  file: OpenFile
  entrySet: CombinedDiffEntrySet
  setSections: Dispatch<SetStateAction<DiffSection[]>>
  viewStateKey: string
}): Set<string> {
  const reviews = useReviewedDiffs()
  const applied = useRef(new Map<string, ReviewedDiff>())
  const { entries, treeMode } = entrySet
  const owner = useMemo(() => {
    try {
      return getEditorFileReadContext(readAppState(), file, file.filePath)
    } catch {
      return null
    }
  }, [file])
  const keyFor = useCallback(
    (entry: DiffReviewEntry, source: 'unstaged' | 'staged' | 'branch') => {
      try {
        return combinedDiffReviewIdentity(file, {
          path: entry.path,
          area: source === 'branch' ? undefined : source
        }).key
      } catch {
        return null
      }
    },
    [file]
  )
  useRevalidateSourceControlReviews(
    { owner, keyFor },
    entrySet.uncommittedEntries,
    entrySet.isCommitMode ? entrySet.commitEntries : entrySet.renderableBranchEntries
  )
  const viewedSectionKeys = useMemo(() => {
    const keys = new Set<string>()
    if (reviews.size === 0) {
      return keys
    }
    for (const entry of entries) {
      try {
        const identity = combinedDiffReviewIdentity(file, {
          path: entry.path,
          area: 'area' in entry ? entry.area : undefined
        })
        if (reviews.get(identity.key)?.entrySignature === reviewEntrySignature(entry)) {
          keys.add(getCombinedDiffFileTreeSectionKey(treeMode, entry))
        }
      } catch {
        /* Unresolved owners cannot inherit review marks. */
      }
    }
    return keys
  }, [entries, file, reviews, treeMode])
  useEffect(() => {
    let cancelled = false
    if (reviews.size === 0) {
      return
    }
    for (const entry of entries) {
      const collapse = async (): Promise<void> => {
        try {
          const { key } = combinedDiffReviewIdentity(file, {
            path: entry.path,
            area: 'area' in entry ? entry.area : undefined
          })
          const record = reviews.get(key)
          const appliedKey = JSON.stringify([viewStateKey, key])
          if (
            !record ||
            record.entrySignature !== reviewEntrySignature(entry) ||
            applied.current.get(appliedKey) === record
          ) {
            return
          }
          const operation = acquireCombinedDiffSectionOperation(file, entry.path)
          const modifiedTime =
            file.diffSource === 'combined-commit'
              ? null
              : await statRuntimePath(operation.context, joinPath(file.filePath, entry.path)).then(
                  (stat) => stat.mtime,
                  (error: unknown) => {
                    if (isMissingRuntimePathError(error)) {
                      return null
                    }
                    throw error
                  }
                )
          operation.assertCurrent()
          if (cancelled || getReviewedDiffs().get(key) !== record) {
            return
          }
          if (modifiedTime !== record.modifiedTime) {
            setDiffReviewed(key, null)
            return
          }
          // Apply each mark once so manually expanding a reviewed file still works.
          applied.current.set(appliedKey, record)
          const sectionKey = getCombinedDiffFileTreeSectionKey(treeMode, entry)
          setSections((previous) => {
            if (cancelled || getReviewedDiffs().get(key) !== record) {
              return previous
            }
            return previous.map((section) =>
              section.key === sectionKey &&
              !section.collapsed &&
              !section.dirty &&
              !section.saveConflict &&
              reviewEntrySignature(section) === record.entrySignature
                ? { ...section, collapsed: true }
                : section
            )
          })
        } catch {
          // Leave changes expanded when their current owner or modification time cannot be verified.
        }
      }
      void collapse()
    }
    return () => {
      cancelled = true
    }
  }, [entries, file, reviews, setSections, treeMode, viewStateKey])
  return viewedSectionKeys
}
