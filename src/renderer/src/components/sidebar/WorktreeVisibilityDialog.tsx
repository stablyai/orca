import React, { useCallback } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/worktree-ownership'

export default function WorktreeVisibilityDialog(): React.JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const repos = useAppStore((s) => s.repos)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)

  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const repo = repos.find((candidate) => candidate.id === repoId) ?? null
  const detected = repoId ? detectedWorktreesByRepo[repoId] : undefined
  const showOther = repo
    ? effectiveExternalWorktreeVisibility(repo, isLegacyRepoForExternalWorktreeVisibility(repo)) ===
      'show'
    : false
  const hiddenCount =
    detected?.authoritative === true
      ? detected.worktrees.filter((worktree) => !worktree.visible).length
      : 0
  const otherCount =
    detected?.authoritative === true
      ? detected.worktrees.filter(
          (worktree) => !worktree.selectedCheckout && worktree.ownership !== 'orca-managed'
        ).length
      : 0
  const hiddenWorktreeLabel = `${hiddenCount} ${hiddenCount === 1 ? 'worktree' : 'worktrees'}`
  const shownWorktreeLabel = `${otherCount} ${otherCount === 1 ? 'worktree' : 'worktrees'}`

  const handleToggle = useCallback(async () => {
    if (!repoId) {
      return
    }
    await updateRepo(repoId, { externalWorktreeVisibility: showOther ? 'hide' : 'show' })
    await fetchWorktrees(repoId)
    closeModal()
  }, [closeModal, fetchWorktrees, repoId, showOther, updateRepo])

  if (activeModal !== 'worktree-visibility' || !repo || !isGitRepoKind(repo)) {
    return null
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Non-Orca worktrees</DialogTitle>
          <DialogDescription>{repo.displayName}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
            {showOther ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {showOther ? 'Shown in sidebar' : 'Hidden from sidebar'}
            </div>
            <div className="text-xs text-muted-foreground">
              {showOther
                ? `${shownWorktreeLabel} currently shown`
                : `${hiddenWorktreeLabel} available to import`}
            </div>
          </div>
          <Button
            type="button"
            variant={showOther ? 'secondary' : 'outline'}
            onClick={handleToggle}
          >
            {showOther ? 'Hide' : 'Import'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
