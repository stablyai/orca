import { useEffect, useMemo, useRef, useState } from 'react'
import { readAppState, useAppStore } from '@/store'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffContent } from '../../editor-panel-content-types'
import { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import {
  diffReviewKey,
  diffReviewScope,
  setDiffReviewed,
  useReviewedDiffs
} from '@/lib/editor/diff-reviewed-files'
import { diffReviewContentSignature } from './diff-review-content-signature'
import { useDiffReviewReadInvalidation } from './use-diff-review-read-invalidation'
import { requestViewedMark } from './diff-viewed-invocation'

// Inverse of the joinPath(worktreePath, entry.path) composition that diff files
// are opened with; separator-agnostic so the root survives `/` vs `\` handling.
function worktreeRootOf(filePath: string, relativePath: string): string | null {
  for (const separator of ['/', '\\']) {
    const joined = separator + relativePath.replaceAll('/', separator)
    if (filePath.endsWith(joined)) {
      return filePath.slice(0, filePath.length - joined.length)
    }
  }
  return null
}

export function useDiffViewed(
  file: OpenFile,
  content: DiffContent | undefined,
  viewId?: string | null
) {
  const t = useTranslate()
  const records = useReviewedDiffs()
  const latestContent = useRef<DiffContent | undefined>(undefined)
  const mounted = useRef(false)
  useEffect(() => {
    latestContent.current = content
  }, [content])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [pending, setPending] = useState(false)
  const owner = useMemo(() => {
    try {
      return getEditorFileReadContext(
        readAppState(),
        file,
        worktreeRootOf(file.filePath, file.relativePath)
      )
    } catch {
      return null
    }
  }, [file])
  const liveBranchCompare = useAppStore((s) =>
    file.diffSource === 'branch' ? s.gitBranchCompareSummaryByWorktree[file.worktreeId] : undefined
  )
  // Branch marks share the scope the source-control side derives from the live
  // summary, so a compare refresh cannot orphan the advance-to-next-file keys.
  const scope = diffReviewScope(
    file.diffSource === 'branch' && liveBranchCompare?.status === 'ready'
      ? { ...file, branchCompare: liveBranchCompare }
      : file
  )
  const key = owner ? diffReviewKey(owner, file.relativePath, scope) : null
  const record = key ? records.get(key) : undefined
  const signature = useMemo(() => {
    if (
      !content ||
      content.isStale ||
      content.loadError ||
      (content.kind === 'text' ? content.largeDiffRenderLimit?.limited : content.tooLarge)
    ) {
      return null
    }
    return diffReviewContentSignature(content)
  }, [content])
  const viewed =
    !file.isDirty &&
    record != null &&
    !content?.isStale &&
    !content?.loadError &&
    (signature === null || record.contentSignature === signature) &&
    (content?.reviewModifiedTime === undefined ||
      record.modifiedTime === content.reviewModifiedTime)
  const eligible =
    content?.reviewModifiedTime !== undefined &&
    !content?.isStale &&
    !content?.loadError &&
    !file.isDirty &&
    !file.externalMutation

  useDiffReviewReadInvalidation({
    key,
    record,
    signature,
    modifiedTime: content?.reviewModifiedTime,
    valid: !content?.isStale
  })

  const toggle = async (): Promise<void> => {
    if (!owner || !key || !eligible || pending || !content) {
      return
    }
    if (viewed) {
      setDiffReviewed(key, null)
      return
    }
    // Null signature means an over-limit or binary-too-large diff; the combined
    // viewer rejects such marks, so the individual viewer must not persist one.
    if (signature === null) {
      return
    }
    setPending(true)
    await requestViewedMark({
      file,
      owner,
      key,
      scope,
      content,
      viewId,
      signature,
      records,
      isCurrentContent: () => latestContent.current === content,
      isMounted: () => mounted.current,
      setPending,
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
  return {
    viewed,
    disabled: !eligible || !owner || !key || pending || (!viewed && signature === null),
    toggle
  }
}
