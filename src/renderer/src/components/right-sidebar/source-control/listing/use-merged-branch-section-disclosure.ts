import { useEffect, useState, type RefObject } from 'react'
import {
  mergedBranchSectionOwnerKey,
  readMergedBranchSectionRecord,
  resolveMergedBranchProof,
  stepMergedBranchSection,
  writeMergedBranchSectionRecord,
  type MergedBranchProof,
  type MergedBranchSectionOwner,
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
  owner,
  isMainWorktree,
  review,
  statusHeadOid,
  uncommittedCount,
  branchDiffEditorActive,
  setBranchSectionAutoCollapsed,
  sectionRef
}: {
  owner: MergedBranchSectionOwner
  isMainWorktree: boolean
  review: MergedBranchSectionReview | null
  statusHeadOid: string | null
  uncommittedCount: number
  branchDiffEditorActive: boolean
  setBranchSectionAutoCollapsed: (collapsed: boolean) => void
  sectionRef: RefObject<HTMLElement | null>
}): { mergedReview: MergedBranchProof | null } {
  const ownerKey = mergedBranchSectionOwnerKey(owner)
  const ownerId = owner.id
  const ownerHostId = owner.hostId
  const ownerInstanceId = owner.instanceId
  const [memory, setMemory] = useState(() => ({
    ownerKey,
    merged: readMergedBranchSectionRecord(owner).merged
  }))
  if (memory.ownerKey !== ownerKey) {
    setMemory({ ownerKey, merged: readMergedBranchSectionRecord(owner).merged })
  }
  const lastMerged = memory.ownerKey === ownerKey ? memory.merged : null

  const reviewProvider = review?.provider
  const reviewNumber = review?.number
  const reviewState = review?.state
  const reviewHeadSha = review?.headSha
  const reviewContainedHeadOid = review?.confirmedContainedHeadOid
  useEffect(() => {
    const effectOwner = { id: ownerId, hostId: ownerHostId, instanceId: ownerInstanceId }
    const record = readMergedBranchSectionRecord(effectOwner)
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
    writeMergedBranchSectionRecord(effectOwner, step.record)
    setMemory({ ownerKey: mergedBranchSectionOwnerKey(effectOwner), merged: step.record.merged })
    if (step.action === 'collapse') {
      moveFocusOutOfBranchRows(sectionRef.current)
      setBranchSectionAutoCollapsed(true)
    } else if (step.action === 'expand') {
      setBranchSectionAutoCollapsed(false)
    }
  }, [
    branchDiffEditorActive,
    isMainWorktree,
    ownerHostId,
    ownerId,
    ownerInstanceId,
    reviewContainedHeadOid,
    reviewHeadSha,
    reviewNumber,
    reviewProvider,
    reviewState,
    sectionRef,
    setBranchSectionAutoCollapsed,
    statusHeadOid,
    uncommittedCount
  ])

  return { mergedReview: resolveMergedBranchProof(lastMerged, review, statusHeadOid) }
}
