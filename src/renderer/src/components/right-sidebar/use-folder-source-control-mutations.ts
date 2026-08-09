import { useCallback, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  bulkStageRuntimeGitPaths,
  commitRuntimeGit,
  discardRuntimeGitPath,
  stageRuntimeGitPath,
  unstageRuntimeGitPath,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
import type { GitStatusEntry } from '../../../../shared/types'
import type { RepoStatusState } from './folder-source-control-rows'
import { useFolderSourceControlBulkActions } from './folder-source-control-bulk-actions'
import type { PendingDiscardConfirmation } from './source-control-discard-dialog'

export function useFolderSourceControlMutations({
  context,
  statusState,
  loadDetails,
  onBranchChanged
}: {
  context: RuntimeGitContext
  statusState: RepoStatusState | undefined
  loadDetails: () => Promise<void>
  onBranchChanged?: () => void
}): {
  operationError: string | null
  stageAll: () => void
  stageAllBusy: boolean
  stageEntry: (entry: GitStatusEntry) => void
  unstageEntry: (entry: GitStatusEntry) => void
  discardEntry: (entry: GitStatusEntry) => void
  stageAllArea: (area: 'unstaged' | 'untracked') => void
  unstageAllArea: (area: 'staged') => void
  requestDiscardAll: (area: 'unstaged' | 'untracked') => void
  confirmPendingDiscard: () => void
  pendingDiscard: PendingDiscardConfirmation | null
  setPendingDiscard: (value: PendingDiscardConfirmation | null) => void
  commitMessage: string
  setCommitMessage: (value: string) => void
  commitBusy: boolean
  commitError: string | null
  handleCommit: () => Promise<void>
  handleCreatePrClick: () => void
  createReviewBlocked: boolean
  createReviewDialogOpen: boolean
  setCreateReviewDialogOpen: (open: boolean) => void
} {
  const [operationError, setOperationError] = useState<string | null>(null)
  const [stageAllBusy, setStageAllBusy] = useState(false)
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscardConfirmation | null>(null)
  const [createReviewBlocked, setCreateReviewBlocked] = useState(false)
  const [createReviewDialogOpen, setCreateReviewDialogOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [commitBusy, setCommitBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  const runOperation = useCallback(async (operation: () => Promise<void>) => {
    setOperationError(null)
    try {
      await operation()
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const {
    stageAllArea: bulkStageAllArea,
    unstageAllArea: bulkUnstageAllArea,
    discardAllArea
  } = useFolderSourceControlBulkActions({
    context,
    entries: statusState?.status?.entries ?? [],
    loadDetails,
    onBranchChanged
  })

  const stageAll = useCallback(() => {
    void runOperation(async () => {
      const entries = statusState?.status?.entries ?? []
      const paths = entries.filter((entry) => entry.area !== 'staged').map((entry) => entry.path)
      if (paths.length === 0) {
        return
      }
      setStageAllBusy(true)
      try {
        await bulkStageRuntimeGitPaths(context, paths)
        onBranchChanged?.()
        await loadDetails()
      } finally {
        setStageAllBusy(false)
      }
    })
  }, [context, loadDetails, onBranchChanged, runOperation, statusState?.status?.entries])

  const stageEntry = useCallback(
    (entry: GitStatusEntry) => {
      void runOperation(async () => {
        await stageRuntimeGitPath(context, entry.path)
        onBranchChanged?.()
        await loadDetails()
      })
    },
    [context, loadDetails, onBranchChanged, runOperation]
  )

  const unstageEntry = useCallback(
    (entry: GitStatusEntry) => {
      void runOperation(async () => {
        await unstageRuntimeGitPath(context, entry.path)
        onBranchChanged?.()
        await loadDetails()
      })
    },
    [context, loadDetails, onBranchChanged, runOperation]
  )

  const discardEntry = useCallback((entry: GitStatusEntry) => {
    setPendingDiscard({ kind: 'entry', entry })
  }, [])

  const stageAllArea = useCallback(
    (area: 'unstaged' | 'untracked') => {
      void runOperation(() => bulkStageAllArea(area))
    },
    [bulkStageAllArea, runOperation]
  )

  const unstageAllArea = useCallback(
    (area: 'staged') => {
      void runOperation(() => bulkUnstageAllArea(area))
    },
    [bulkUnstageAllArea, runOperation]
  )

  const requestDiscardAll = useCallback(
    (area: 'unstaged' | 'untracked') => {
      const paths = (statusState?.status?.entries ?? [])
        .filter((entry) => entry.area === area)
        .map((entry) => entry.path)
      if (paths.length > 0) {
        setPendingDiscard({ kind: 'area', area, paths })
      }
    },
    [statusState?.status?.entries]
  )

  const confirmPendingDiscard = useCallback(() => {
    const pending = pendingDiscard
    if (!pending) {
      return
    }
    setPendingDiscard(null)
    if (pending.kind === 'entry') {
      const entry = pending.entry
      void runOperation(async () => {
        await discardRuntimeGitPath(context, entry.path)
        onBranchChanged?.()
        await loadDetails()
      })
      return
    }
    const area = pending.area
    if (area === 'staged') {
      return
    }
    void runOperation(() => discardAllArea(area))
  }, [context, discardAllArea, loadDetails, onBranchChanged, pendingDiscard, runOperation])

  const handleCommit = useCallback(async () => {
    const message = commitMessage.trim()
    if (!message || commitBusy) {
      return
    }
    setCommitBusy(true)
    setCommitError(null)
    try {
      const result = await commitRuntimeGit(context, message)
      if (!result.success) {
        setCommitError(
          result.error ??
            translate(
              'auto.components.right.sidebar.use.folder.source.control.mutations.ef03028f27',
              'Commit failed'
            )
        )
        return
      }
      setCommitMessage('')
      setCreateReviewBlocked(false)
      onBranchChanged?.()
      await loadDetails()
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error))
    } finally {
      setCommitBusy(false)
    }
  }, [commitBusy, commitMessage, context, loadDetails, onBranchChanged])

  const handleCreatePrClick = useCallback(() => {
    const dirty = (statusState?.status?.entries.length ?? 0) > 0
    setCreateReviewBlocked(dirty)
    if (!dirty) {
      setCreateReviewBlocked(false)
      setCreateReviewDialogOpen(true)
    }
  }, [statusState?.status?.entries.length])

  return {
    operationError,
    stageAll,
    stageAllBusy,
    stageEntry,
    unstageEntry,
    discardEntry,
    stageAllArea,
    unstageAllArea,
    requestDiscardAll,
    confirmPendingDiscard,
    pendingDiscard,
    setPendingDiscard,
    commitMessage,
    setCommitMessage,
    commitBusy,
    commitError,
    handleCommit,
    handleCreatePrClick,
    createReviewBlocked,
    createReviewDialogOpen,
    setCreateReviewDialogOpen
  }
}
