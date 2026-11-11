import { acquireCombinedDiffSectionOperation } from '../load-sections/combined-diff-section-connection'
import type { fetchCombinedDiffSection } from '../load-sections/fetch-combined-diff-section'
import { getLargeDiffRenderLimit } from '../../../../../../shared/large-diff-render-limit'
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { useTranslate } from '@/i18n/use-translate'
import {
  reviewEntrySignature,
  setDiffReviewed,
  useReviewedDiffs
} from '@/lib/editor/diff-reviewed-files'
import { joinPath } from '@/lib/path'
import {
  statRuntimePath,
  isMissingRuntimePathError
} from '@/runtime/files/metadata/runtime-file-metadata-client'
import { DiffViewedCheckbox } from '../../diff/review/diff-viewed-checkbox'
import { diffReviewContentSignature } from '../../diff/review/diff-review-content-signature'
import { useDiffReviewReadInvalidation } from '../../diff/review/use-diff-review-read-invalidation'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { combinedDiffReviewIdentity } from './combined-diff-review-identity'

// Module-scope body: React Compiler cannot lower component-scope try/finally here.
async function requestCombinedViewedMark({
  file,
  section,
  signature,
  loadForReview,
  isCurrentSection,
  isMounted,
  setPending,
  setSections,
  onFailure
}: {
  file: OpenFile
  section: DiffSection
  signature: string | null
  loadForReview?: () => ReturnType<typeof fetchCombinedDiffSection>
  isCurrentSection: (modifiedTime: number | null | undefined) => boolean
  isMounted: () => boolean
  setPending: (pending: boolean) => void
  setSections: Dispatch<SetStateAction<DiffSection[]>>
  onFailure: () => void
}): Promise<void> {
  try {
    let assertLoadedCurrent: (() => void) | undefined
    let expectedTime = section.reviewModifiedTime
    if (signature === null || expectedTime === undefined) {
      const loaded = await loadForReview!()
      expectedTime = await loaded.reviewModifiedTime
      assertLoadedCurrent = loaded.operation.assertCurrent
      assertLoadedCurrent()
      const result = loaded.result
      if (
        expectedTime === undefined ||
        (result.kind === 'binary' && result.tooLarge) ||
        (result.kind === 'text' &&
          (result.largeDiffRenderLimit ?? getLargeDiffRenderLimit(result)).limited)
      ) {
        throw new Error('Diff cannot be marked as viewed')
      }
      signature = diffReviewContentSignature(result)
    }
    const { key } = combinedDiffReviewIdentity(file, section)
    const operation = acquireCombinedDiffSectionOperation(file, section.path)
    const modifiedTime =
      file.diffSource === 'combined-commit'
        ? null
        : await statRuntimePath(operation.context, joinPath(file.filePath, section.path)).then(
            (stat) => stat.mtime,
            (error: unknown) => {
              if (isMissingRuntimePathError(error)) {
                return null
              }
              throw error
            }
          )
    operation.assertCurrent()
    assertLoadedCurrent?.()
    if (!isMounted()) {
      return
    }
    if (expectedTime !== modifiedTime) {
      onFailure()
      return
    }
    if (!isCurrentSection(modifiedTime)) {
      return
    }
    setDiffReviewed(key, {
      viewedAt: Date.now(),
      modifiedTime,
      contentSignature: signature,
      entrySignature: reviewEntrySignature(section)
    })
    setSections((sections) =>
      sections.map((current) =>
        current.key === section.key && !current.dirty ? { ...current, collapsed: true } : current
      )
    )
  } catch {
    onFailure()
  } finally {
    if (isMounted()) {
      setPending(false)
    }
  }
}

export function CombinedDiffViewedControl({
  file,
  section,
  setSections,
  loadForReview,
  onExpand
}: {
  loadForReview?: () => ReturnType<typeof fetchCombinedDiffSection>
  onExpand?: () => void
  file: OpenFile
  section: DiffSection
  setSections: Dispatch<SetStateAction<DiffSection[]>>
}): React.JSX.Element {
  const t = useTranslate()
  const records = useReviewedDiffs()
  const [pending, setPending] = useState(false)
  const latest = useRef<DiffSection>(section)
  useEffect(() => {
    latest.current = section
  }, [section])
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const identity = useMemo(() => {
    try {
      return combinedDiffReviewIdentity(file, { path: section.path, area: section.area })
    } catch {
      return null
    }
  }, [file, section.path, section.area])
  const record = identity ? records.get(identity.key) : undefined
  const signature = useMemo(
    () => (section.diffResult ? diffReviewContentSignature(section.diffResult) : null),
    [section.diffResult]
  )
  const viewed =
    !section.dirty &&
    !section.saveConflict &&
    record?.entrySignature === reviewEntrySignature(section) &&
    (signature === null || record.contentSignature === signature) &&
    (section.reviewModifiedTime === undefined || record.modifiedTime === section.reviewModifiedTime)
  const blocked =
    section.error ||
    section.largeDiffRenderLimit?.limited ||
    (section.diffResult?.kind === 'binary' && section.diffResult.tooLarge)
  const unavailable =
    !section.diffResult ||
    section.loading ||
    section.loadOnDemand ||
    blocked ||
    section.reviewModifiedTime === undefined
  const disabled =
    !identity ||
    pending ||
    section.dirty ||
    !!section.saveConflict ||
    (!viewed && (!!blocked || (!!unavailable && !loadForReview)))

  useDiffReviewReadInvalidation({
    key: identity?.key ?? null,
    record,
    signature,
    entrySignature: reviewEntrySignature(section),
    modifiedTime: section.reviewModifiedTime,
    valid: !section.loading && !section.dirty
  })

  const toggle = async (): Promise<void> => {
    if (disabled || !identity) {
      return
    }
    if (viewed) {
      setDiffReviewed(identity.key, null)
      if (section.collapsed && onExpand) {
        onExpand()
      } else {
        setSections((sections) =>
          sections.map((current) =>
            current.key === section.key ? { ...current, collapsed: false } : current
          )
        )
      }
      return
    }
    setPending(true)
    await requestCombinedViewedMark({
      file,
      section,
      signature: section.loading || section.loadOnDemand ? null : signature,
      loadForReview,
      isCurrentSection: (modifiedTime) => {
        const current = latest.current
        return (
          !current.dirty &&
          !current.saveConflict &&
          current.diffResult === section.diffResult &&
          (current.reviewModifiedTime === undefined ||
            current.reviewModifiedTime === modifiedTime) &&
          reviewEntrySignature(current) === reviewEntrySignature(section)
        )
      },
      isMounted: () => mounted.current,
      setPending,
      setSections,
      onFailure: () => {
        toast.error(
          t(
            'diffReview.failed',
            "Couldn't mark this file as viewed. Reopen the diff and try again."
          )
        )
      }
    })
  }
  return (
    <div onClick={(event) => event.stopPropagation()}>
      <DiffViewedCheckbox viewed={viewed} disabled={disabled} onToggle={() => void toggle()} />
    </div>
  )
}
