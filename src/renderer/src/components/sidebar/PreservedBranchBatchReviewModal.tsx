import { useEffect, useMemo, useRef } from 'react'
import {
  preservedBranchCleanupKey,
  type PreservedBranchCleanup
} from '@/lib/preserved-branch-cleanup'
import { useAppStore } from '@/store'
import { PreservedBranchBatchReviewDialog } from './PreservedBranchBatchReviewDialog'
import {
  forceDeletePreservedBranchBatch,
  type ActionablePreservedBranch
} from './preserved-branch-batch-toast'

function isPreservedBranchCleanup(value: unknown): value is PreservedBranchCleanup {
  if (!value || typeof value !== 'object') {
    return false
  }
  const branch = value as Partial<PreservedBranchCleanup>
  return (
    (branch.cleanupId === undefined || typeof branch.cleanupId === 'string') &&
    typeof branch.worktreeId === 'string' &&
    typeof branch.branchName === 'string' &&
    (branch.expectedHead === undefined || typeof branch.expectedHead === 'string') &&
    (branch.hostId === undefined || typeof branch.hostId === 'string') &&
    (branch.runtimeEnvironmentId === undefined || typeof branch.runtimeEnvironmentId === 'string')
  )
}

function getModalBranches(value: unknown): PreservedBranchCleanup[] {
  return Array.isArray(value) ? value.filter(isPreservedBranchCleanup) : []
}

export default function PreservedBranchBatchReviewModal(): React.JSX.Element {
  const activeModal = useAppStore((state) => state.activeModal)
  const modalData = useAppStore((state) => state.modalData)
  const closeModal = useAppStore((state) => state.closeModal)
  const releasePreservedBranchCleanups = useAppStore(
    (state) => state.releasePreservedBranchCleanups
  )
  const branches = useMemo(() => getModalBranches(modalData.branches), [modalData.branches])
  const open = activeModal === 'preserved-branch-review' && branches.length > 0
  const reviewKey = branches.map(preservedBranchCleanupKey).join('\0')
  const ownedBranches = useRef<readonly PreservedBranchCleanup[]>([])
  useEffect(() => {
    const previous = ownedBranches.current
    if (previous.length > 0 && previous !== branches) {
      void releasePreservedBranchCleanups(previous)
    }
    ownedBranches.current = open ? branches : []
  }, [branches, open, releasePreservedBranchCleanups])

  const handleForceDelete = (selectedBranches: readonly ActionablePreservedBranch[]): void => {
    const selectedKeys = new Set(selectedBranches.map(preservedBranchCleanupKey))
    const unselectedBranches = branches.filter(
      (branch) => !selectedKeys.has(preservedBranchCleanupKey(branch))
    )
    ownedBranches.current = []
    closeModal()
    void releasePreservedBranchCleanups(unselectedBranches)
    void forceDeletePreservedBranchBatch(selectedBranches)
  }

  return (
    <PreservedBranchBatchReviewDialog
      key={reviewKey}
      branches={branches}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          ownedBranches.current = []
          closeModal()
          void releasePreservedBranchCleanups(branches)
        }
      }}
      onForceDelete={handleForceDelete}
    />
  )
}
