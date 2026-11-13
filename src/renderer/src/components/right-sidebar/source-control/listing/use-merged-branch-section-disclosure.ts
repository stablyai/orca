import { useEffect, useState, type RefObject } from 'react'
import {
  readMergedBranchSectionRecord,
  resolveMergedBranchProof,
  stepMergedBranchSection,
  writeMergedBranchSectionRecord,
  type MergedBranchProof,
  type MergedBranchSectionReview
} from './merged-branch-section-disclosure'

/** Keeps keyboard focus on the header when the rows it sits in are about to unmount. */
function moveFocusOutOfBranchRows(section: HTMLElement | null): void {
  const toggle = section?.querySelector<HTMLButtonElement>('button[aria-expanded]')
  const focused = document.activeElement
  if (!section || !toggle || !focused || !section.contains(focused)) {
    return
  }
  if (!toggle.parentElement?.contains(focused)) {
    toggle.focus()
  }
}

/** Marks the branch compare section merged and owns its one automatic collapse per session. */
export function useMergedBranchSectionDisclosure({
  worktreeId,
  isMainWorktree,
  review,
  statusHeadOid,
  uncommittedCount,
  branchDiffEditorActive,
  setBranchSectionCollapsed,
  sectionRef
}: {
  worktreeId: string
  isMainWorktree: boolean
  review: MergedBranchSectionReview | null
  statusHeadOid: string | null
  uncommittedCount: number
  branchDiffEditorActive: boolean
  setBranchSectionCollapsed: (collapsed: boolean) => void
  sectionRef: RefObject<HTMLElement | null>
}): { mergedReview: MergedBranchProof | null } {
  const [memory, setMemory] = useState(() => ({
    worktreeId,
    merged: readMergedBranchSectionRecord(worktreeId).merged
  }))
  if (memory.worktreeId !== worktreeId) {
    setMemory({ worktreeId, merged: readMergedBranchSectionRecord(worktreeId).merged })
  }
  const lastMerged = memory.worktreeId === worktreeId ? memory.merged : null

  const reviewProvider = review?.provider
  const reviewNumber = review?.number
  const reviewState = review?.state
  const reviewHeadSha = review?.headSha
  const reviewContainedHeadOid = review?.confirmedContainedHeadOid
  useEffect(() => {
    const record = readMergedBranchSectionRecord(worktreeId)
    const step = stepMergedBranchSection(record, {
      review:
        reviewProvider && reviewNumber !== undefined && reviewState
          ? {
              provider: reviewProvider,
              number: reviewNumber,
              state: reviewState,
              headSha: reviewHeadSha,
              confirmedContainedHeadOid: reviewContainedHeadOid
            }
          : null,
      statusHeadOid,
      uncommittedCount,
      isMainWorktree,
      branchDiffEditorActive
    })
    if (step.record === record) {
      return
    }
    writeMergedBranchSectionRecord(worktreeId, step.record)
    setMemory({ worktreeId, merged: step.record.merged })
    if (step.action === 'collapse') {
      moveFocusOutOfBranchRows(sectionRef.current)
      setBranchSectionCollapsed(true)
    } else if (step.action === 'expand') {
      setBranchSectionCollapsed(false)
    }
  }, [
    branchDiffEditorActive,
    isMainWorktree,
    reviewContainedHeadOid,
    reviewHeadSha,
    reviewNumber,
    reviewProvider,
    reviewState,
    sectionRef,
    setBranchSectionCollapsed,
    statusHeadOid,
    uncommittedCount,
    worktreeId
  ])

  return { mergedReview: resolveMergedBranchProof(lastMerged, review, statusHeadOid) }
}
